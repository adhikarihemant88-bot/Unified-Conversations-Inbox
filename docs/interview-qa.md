# Unified Conversations Inbox: Interview Q&A

Prepared from the README, `AI_USAGE.md` and the source. Answers are written in first person so you can say them out loud. Edit them into your own words, and re-read the code paths named in each answer before the interview.

**Contents**
1. Overview and design
2. Data model
3. Inbound webhook, idempotency and concurrency
4. Status ordering
5. Outbound queue and retries
6. Pagination
7. Real-time (SSE), typing and presence
8. Security and multi-tenancy
9. Validation and error handling
10. Testing
11. Scaling to 10,000 msgs/sec
12. Trade-offs and what I'd improve
13. AI usage
14. Curveballs and live-coding

---

## 1. Overview and design

**Q1. Give me a 60-second summary of what you built.**
It is a NestJS, TypeScript and PostgreSQL backend for a unified inbox. A conversation is one per participant pair per location. It is shared across SMS, WhatsApp and email, and messages in either direction land in it. It has an inbound webhook, a status-callback webhook, an outbound send queue with a retrying worker, snapshot-based pagination, SSE for real-time updates with replay, full-text search, and typing and presence as bonuses. Providers are mocked. The main focus is correctness under concurrency: idempotent inbound messages, monotonic delivery status, no lost unread counters and location isolation.

**Q2. Why NestJS + Postgres, and why no Redis?**
Nest gives me modules, DI, DTO validation pipes, guards and interceptors, which suit a layered API. Postgres gives me transactions, row locks, unique constraints, `FOR UPDATE SKIP LOCKED` and GIN full-text search, and those covered every concurrency problem in the brief. Using the database for the queue, event log and snapshots means one service to run, and writes commit atomically with their events and jobs. Redis would add a second system and a dual-write problem. I'd bring in a broker only at much higher scale (see section 11).

**Q3. How is the code organized?**
- `src/webhook/`: inbound and status webhooks, plus storage helpers for provider locks and status.
- `src/inbox/`: conversation APIs, outbound sending, the worker, pagination, search and SSE. Shared domain logic is in `domain.ts`.
- `src/admin/`: agent creation.
- `src/common/`: bearer auth, `LocationScopeGuard`, validation decorators, the exception filter and the response interceptor.
- `src/entities/`: TypeORM entities, mapped with `synchronize: false`.
- `db/001_init.sql`: the migration, which is the schema's single source of truth.
- `src/sql/`: the same logic as plain SQL functions, as a reference.

**Q4. Why does `src/sql/` exist if the app doesn't call those functions?**
It is a plain-SQL reference of the same rules: constraints, indexes, ingestion, status callbacks, queueing and claiming. It shows the logic can live in the database and lets anyone check the rules without reading TypeScript. The caveat, which the SQL README states, is that the two must be kept in step if either changes.

**Q5. What assumptions did you make where the brief was vague?**
- Provider message IDs are globally unique, because the status payload has no channel or location.
- `failed` is terminal.
- Phone numbers need a country code, and I don't guess one.
- An email and a phone are the same person only if they are explicitly linked (seeded). Otherwise they are separate contacts.
- Each agent belongs to exactly one location (brief: "Agents must only receive events for their own location"), so assignment only picks agents from the conversation's location.
- "Read" means an agent has read it. It doesn't produce a provider read receipt.

I documented each one in the README.

---

## 2. Data model

**Q6. Walk me through the schema.**
- `locations`: integer ID plus a unique name. The webhook's `locationId` such as `loc_1` is the name.
- `agents`: each belongs to one location (`location_id`), with `last_assigned_at` for per-location round-robin. A composite FK `(location_id, assigned_to)` on `conversations` stops cross-location assignment at the database level.
- `contacts` and `contact_identities`: a contact is one participant in one location. Identities (phone or email) are unique on `(location_id, kind, value)` and point to a contact.
- `conversations`: unique on `(location_id, participant_a_id, participant_b_id)`, with the two IDs numerically sorted. It also has an unread count (checked non-negative) and a status (open or closed).
- `messages`: unique `provider_message_id`, and checked channel, direction and status.
- `provider_states`: per-provider-ID status and lock row.
- `send_jobs`: attempts, state and next-retry time.
- `inbox_events`: the transactional event log.
- `pagination_snapshots`: frozen ordered results, expiring after 15 minutes.

**Q7. How do you make a conversation the same for A→B and B→A?**
I sort the two contact IDs numerically and store them as `participant_a_id` and `participant_b_id`. The unique key is `(location, a, b)`, so both directions resolve to the same row. Channel is not part of the key, so SMS, WhatsApp and email all share the conversation. Direction lives on each message, so the A/B order never determines who sent what.

**Q8. Why integer IDs and not UUIDs?**
They are compact, they index well and they sort by insertion. They also work for stable tie-breaks such as `(sent_at, id)`. The cost is that they are guessable, so every endpoint must authorise by location and not rely on ID obscurity. That is why `LocationScopeGuard` resolves a conversation's location and checks it.

**Q9. How do you stop cross-location data leaks at the database level?**
I use composite foreign keys that include `location_id`. A message's `(location_id, conversation_id)` must match a conversation in that same location, and conversations must reference contacts in the same location. Even a direct SQL write can't link rows across locations. The application layer is not the only defence.

**Q10. Which indexes did you add and why?**
- Conversation listing by `(location, last_message_at DESC, id)`.
- Status and assignment filters.
- Contact identity lookup (the unique key doubles as an index).
- Chronological message history by conversation.
- Due pending send jobs, for the worker.
- `(location, event id)` for replay.
- Snapshot expiry, for the purge job.
- GIN on the message body's `tsvector`, for search.

**Q11. How do you normalize phone numbers and emails?**
Phones must include a country code. I strip spaces, parentheses, dots and hyphens and remove a `whatsapp:` prefix, so `+91 98765 43210` and `whatsapp:+919876543210` become the same identity. Emails are trimmed and lowercased. I don't guess country codes, because a wrong guess merges two different people.

**Q12. A customer emails and also texts. Are they one contact?**
Not automatically. Linking identities is an explicit action, and the seed links them. Otherwise an unknown address creates a new contact. I didn't build a merge API because the brief didn't ask for one, and I listed that as a follow-up.

---

## 3. Inbound webhook, idempotency and concurrency

**Q13. Describe the inbound flow end to end.**
1. Validate the DTO and normalize `from`, `to` and `sentAt`.
2. Open a transaction.
3. Lock the `provider_states` row for this provider message ID, creating it if needed.
4. If the message already exists, either return `duplicate: true` with the stored message (same payload) or throw 409 (different payload).
5. Find or create the location.
6. Lock the location row.
7. Resolve both contacts in sorted order.
8. Find or create the conversation. A new conversation gets the least-recently-assigned agent.
9. Insert the message. Its status starts at `delivered`, or later if an early callback already set it.
10. Update the unread count and preview.
11. Write a `message.new` event.
12. Commit.

Everything is one transaction, so there are no partial states.

**Q14. How do you handle duplicate webhooks?**
There are three layers. The `provider_states` row lock serializes concurrent requests with the same ID. An existence check returns the stored message with HTTP 200 and `duplicate: true`, so the provider stops retrying, and it counts, stores and publishes nothing a second time. The unique constraint on `provider_message_id` is the final backstop. If the same ID arrives with a different payload, it is a conflict and returns 409.

**Q15. Why return 200 and not an error for a duplicate?**
Providers retry on non-2xx responses. A retried delivery should be acknowledged as received, and returning an error would trigger more retries.

**Q16. Two first-ever messages arrive at once between the same two people, A→B and B→A. What could go wrong, and how do you prevent it?**
- *Duplicate contacts or conversations.* The unique constraints decide the winner. The loser's insert is ignored (`ON CONFLICT DO NOTHING` via TypeORM's `orIgnore`), and then it re-reads the winner's row.
- *Deadlock.* If one transaction creates A then B and the other creates B then A, they can wait on each other. I resolve addresses in sorted order, so every transaction takes the same lock order.
- *Orphan contact.* The loser deletes only its own unused new contact.

I have a test with 50 simultaneous first messages in both directions.

**Q17. How do you guarantee the unread counter never loses an increment?**
The increment happens inside the transaction, while holding a pessimistic write lock on the conversation row. Concurrent inbounds serialize on that row. The counter increments only for a newly committed message, never for a duplicate. Mark-as-read takes the same lock, so reads and ingests have a defined order.

**Q18. What if a message is read at the same moment a new one arrives?**
Both take the conversation lock. Whichever gets it first goes first. Messages ordered before the read reset are read, and later ones stay unread. The result is deterministic, with no lost increments.

**Q19. What about late messages with an old `sentAt`?**
They can't overwrite newer preview or last-activity metadata. The update only moves forward when the message is newer by `(sentAt, id)`, and the generated ID breaks ties. The message still appears in history in the right order.

**Q20. How are new conversations assigned to agents?**
Round-robin on `last_assigned_at`. Agents who've never been assigned come first, with agent ID breaking ties. A location-row lock serializes assignment, so two concurrent new conversations can't both pick the same stale oldest agent. Later messages on an existing conversation don't reassign it. With no agents, the conversation stays unassigned.

**Q21. Why lock the location row? Isn't that a bottleneck?**
Yes, it serializes new-conversation assignment, manual assignment and event ID allocation within one location. Different locations run in parallel. It is a deliberate correctness-first choice, and the critical sections are short. A hot location is the contention point, and section 11 covers how I'd address it.

**Q22. Why TypeORM when you could write raw SQL?**
It is idiomatic Nest and keeps the webhook flow free of raw SQL. I use the query builder only where I need `INSERT … ON CONFLICT DO NOTHING`, and I set `synchronize: false` so the migration owns the schema. The trade-off is that TypeORM hides some SQL, which is why I check locking and constraint behaviour with real-Postgres integration tests.

---

## 4. Status ordering

**Q23. How do you keep delivery statuses consistent when callbacks arrive out of order?**
Status has a rank: `queued < sent < delivered < read < failed`. An update only applies if it moves forward, via the `advance` function. A late `sent` after `delivered`, a duplicate callback, or the worker finishing after a callback can't lower the status. `failed` is terminal. The callback's timestamp is stored as metadata and is not used to order states.

**Q24. What if the status callback arrives before the message exists?**
I persist it in `provider_states`. That row is created on demand, so even a provider ID with no message yet can be locked and updated. When the inbound message arrives, ingestion holds the same lock and reconciles. The message starts at `delivered` unless the early callback already set a later state.

**Q25. Why is `failed` the highest rank?**
The brief allows failure at any point, so I made it terminal. Once something has failed, a later `delivered` can't flip it back. If real providers can legitimately recover from a failure, that rule would change.

**Q26. Which lock do callbacks, ingestion and the worker share, and why?**
They all take a pessimistic write lock on the `provider_states` row for that provider ID. That makes status changes for one message strictly serial across the three writers.

---

## 5. Outbound queue and retries

**Q27. How does sending work?**
`POST /conversations/:id/messages` creates a `queued` message, a `send_jobs` row, an updated preview and an event, all in one transaction. It returns **202** with the queued message. The worker picks up due jobs, calls the mock provider, and moves the message to `sent` on success.

**Q28. How does the worker avoid two workers taking the same job?**
It claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`. A locked job is skipped, not waited on. So multiple workers or API instances can run safely, and no job is processed twice at once.

**Q29. Explain the retry policy.**
The mock fails with probability `MOCK_FAILURE_RATE` (default 0.2). There are at most 3 total attempts, with backoff of `RETRY_BASE_MS` (1s), then twice that (2s). Only exhausting all attempts marks the message `failed`. Attempt counts live in the database, so they survive restarts.

**Q30. What happens if the app crashes mid-send?**
Pending jobs and attempt counts are durable, so after a restart the worker resumes. The unsafe window is a crash between the external send and the DB commit, because a database transaction can't give exactly-once delivery to a remote service. The mitigation is a stable, preallocated provider ID sent to the provider as an idempotency key.

**Q31. You call the mock inside the job transaction. Is that a problem?**
For a mock, no. For a real provider it holds a transaction and a connection open across a network call. I'd switch to leased jobs: claim and mark them with a lease expiry, commit, call the provider with a timeout outside the transaction, then record the result. A reaper would recover expired leases.

**Q32. How is the reply's sender/recipient decided, and what about switching channels?**
A reply reverses `from` and `to` of the latest inbound message. If the agent switches channel, both participants must have an identity on that channel, or the API returns 400.

**Q33. Can a client double-send?**
Yes. A client retry can create two queued messages. The fix is an idempotency key on the outbound endpoint. I listed it as a known gap, since the brief required webhook idempotency and not outbound idempotency.

---

## 6. Pagination

**Q34. Why snapshot pagination instead of offset or keyset?**
- *Offset* skips or duplicates rows when data changes.
- *Keyset* works for messages, which order by `(sent_at, id)`. It breaks for conversations, because a new message moves an existing conversation to the top, ahead of the cursor, so the client could skip or see it twice.
- *Snapshots* freeze the ordered result on the first request, and later pages read from that frozen list. That gives no skips and no duplicates, even with inserts, reordering and late messages.

**Q35. How does the cursor work?**
It encodes the snapshot ID and the next position. The snapshot is bound to the location, the resource and the filters, so a cursor can't be reused across them. The first request materializes the ordered IDs in one statement. Page size is 1–100, default 25.

**Q36. What if the cursor expires?**
Snapshots live 15 minutes. After that, the API returns **410 Gone** and the client restarts the listing. The worker purges expired snapshots about once a minute when idle.

**Q37. What is the downside?**
Snapshot creation stores the whole result, so cost scales with inbox or history size. Data inside a snapshot is also frozen, so statuses and counters can be stale until a fresh listing. SSE covers live changes. For large histories I'd use bounded or versioned pagination sessions, a cache, and quotas.

---

## 7. Real-time (SSE), typing and presence

**Q38. Why SSE and not WebSockets?**
The updates are one-way, from server to client. SSE is plain HTTP, works through proxies and has built-in reconnect with `Last-Event-ID`. WebSockets would be worth it only if clients needed to send frequent messages over the same channel, and typing is a simple POST.

**Q39. How does the SSE stream work?**
Events are written to the `inbox_events` table in the same transaction as the state change. The stream polls that table every 500ms for events with an ID above the client's watermark, filtered by location. It sends heartbeats about every 15s. A slow consumer is disconnected, and it resumes with `Last-Event-ID`.

**Q40. Why write events in the same transaction?**
It guarantees that nothing uncommitted or rolled back is ever published, and nothing committed is missed. It is the transactional outbox pattern.

**Q41. How do you make sure events aren't skipped by concurrent writers?**
Event IDs come from an increasing sequence, but a sequence alone isn't safe. Transaction 1 could get ID 10 and commit late, while transaction 2 gets ID 11 and commits first. A reader that has seen 11 would then never see 10. So each writer first takes a `FOR NO KEY UPDATE` lock on the location row before allocating an event ID. That serializes allocation per location until commit, so an earlier uncommitted ID can't appear behind the delivered watermark. The weaker lock mode still allows foreign-key checks from other transactions.

**Q42. Does it work with multiple API instances?**
Yes for events, because the log is in the shared database, so there is no sticky session or in-memory broker. Typing and presence are the exception. They are ephemeral and fanned out in memory, so they only reach clients on the same instance. At multi-instance scale I'd use Postgres `LISTEN/NOTIFY` or a broker.

**Q43. Can I use the browser's `EventSource`?**
Not directly, because it can't set an `Authorization` header. Use `fetch` streaming or an SSE library that supports headers.

**Q44. What happens if a client connects without `Last-Event-ID`?**
It starts at the location's current watermark, so there is no replay of old events. The client should fetch current state with a normal listing first.

**Q45. How do typing indicators and presence work?**
`POST /locations/:loc/typing` publishes an ephemeral `typing` event. Opening the stream with `?agentId=` registers the agent as online. Subscribers get `presence.online`, `presence.offline` and an initial `presence.snapshot`. None of these have an event ID, none are stored and none are replayed.

---

## 8. Security and multi-tenancy

**Q46. How does authentication work?**
Each API group has its own bearer token: `INBOX_TOKEN`, `WEBHOOK_TOKEN` and `ADMIN_TOKEN`. A group accepts only its own token, so a leaked inbox token can't call the webhook or admin APIs.

**Q47. How do you isolate locations?**
`INBOX_LOCATION_TOKENS` (for example `loc_1:tokenA,loc_2:tokenB`) gives agents location-scoped credentials. `LocationScopeGuard` returns **403** if the path location, or the stored location of a conversation, doesn't match the token's. This covers the SSE stream too. The shared inbox token is operator-level and crosses locations.

**Q48. Is the token comparison safe?**
It should use a constant-time comparison to avoid timing leaks. Check `src/common/bearer-auth.ts` and be ready to say whether it does.

**Q49. What would you change for production auth?**
- Real credential lifecycle (rotation and revocation, with JWT or OAuth for agents).
- Per-agent authorization policy.
- Provider signature verification (Twilio, Meta), deriving location from the registered provider account and not trusting the payload.
- Secrets in a secret manager.

**Q50. Is there injection risk?**
All queries are parameterized by TypeORM or `$n` placeholders. Search input goes through a Postgres text-search function, not string concatenation. DTO validation rejects unknown fields.

---

## 9. Validation and error handling

**Q51. How is validation done?**
Class-based DTOs with `class-validator`, plus a global `ValidationPipe` registered via `APP_PIPE`, so production and tests use the same pipeline. It transforms to DTO instances, rejects unknown fields, and validates positive integer IDs, non-blank strings, enums, timestamps and cursors. Implicit coercion is off. Limits are explicitly converted from decimal strings to integers between 1 and 100.

**Q52. What was the timestamp bug you found?**
My first `timestamp()` used a loose ISO regex plus `Date.parse`. JavaScript silently normalizes impossible dates, so `2026-02-30` became March 2, which would corrupt message order and previews. I wrote a failing test first (`expect(...).toThrow()` failed), then rewrote the function to validate year, month, day, leap years, clock values and offsets before converting to UTC. It also rejects `24:00:00`.

**Q53. What does the error contract look like?**
Success is `{ status, message: "Success", data }`. Errors are 400 for validation, 401 for unauthorized, 403 for the wrong location, 404 for an unknown location or conversation, 409 for a conflicting provider ID, 410 for an expired cursor, and a generic 500 with details only in server logs.

**Q54. PATCH semantics?**
Omitted fields keep their values. `assignedTo: null` unassigns. An empty body or `status: null` is rejected with 400.

---

## 10. Testing

**Q55. How did you test concurrency?**
Integration tests use a real, disposable PostgreSQL (`embedded-postgres`, or `TEST_DATABASE_URL`) in a random private schema that is dropped afterwards. Mocks can't prove locking or constraints work, so I fire real parallel HTTP requests. The tests cover:
- Concurrent duplicates.
- 50 simultaneous first messages in both directions.
- Participant-pair and location separation.
- Early, reordered and terminal statuses.
- Read versus ingest races.
- Snapshots under inserts.
- Parallel worker claims, backoff and exhaustion.
- Transaction rollback.
- Database-level tenant constraints.
- Authorization and SSE isolation and replay.

**Q56. How do you test retries deterministically if the mock is random?**
Tests inject deterministic failures. Only the normal runtime uses `MOCK_FAILURE_RATE`.

**Q57. What's not tested?**
Be ready to name gaps: long soak or load tests, real provider behaviour, crash recovery mid-send, and multi-instance SSE.

---

## 11. Scaling to 10,000 msgs/sec

**Q58. How would you scale ingestion?**
- Partition by location and participant pair, so per-conversation order holds while unrelated conversations run in parallel.
- Acknowledge only after durable acceptance (a DB commit or a durable broker write).
- Batch writes, partition the message and event tables, tune indexes and pools, and keep dedup on the durable write path.
- A single hot conversation still serializes its counter and ordering. Partitioning can't remove that, so I'd make the unread count an eventually consistent projection if needed.

**Q59. How would you scale real-time?**
Stop polling the DB per connection. Use outbox or event-log consumers feeding a broker partitioned by location, with dedicated SSE gateways that authenticate and fan out. Keep durable event IDs for replay and monitor lag and backpressure.

**Q60. And outbound and pagination?**
Outbound: leased jobs, with provider calls outside transactions and provider-side idempotency. Pagination: replace full-result snapshots with bounded or versioned sessions, plus cached inbox projections.

**Q61. What would break first today?**
Per-connection 500ms polling of the event table, snapshot creation on very large inboxes, and location-row lock contention on a very hot location.

---

## 12. Trade-offs and what I'd improve

**Q62. Biggest trade-offs you made?**
- Locks over lock-free designs: correctness first, at the cost of throughput on hot rows.
- Postgres-only: simpler operations, but polling instead of push.
- Snapshots: exact paging, but storage cost.
- Static tokens: testable, but not production auth.

**Q63. What would you do next with another week?**
- Idempotency keys on outbound sends.
- Event and orphan-state retention.
- Provider signature verification.
- Rate limits and quotas.
- Structured logs and metrics.
- A contact merge API.
- `LISTEN/NOTIFY` in place of polling.
- Attachments.
- Leased worker jobs.

**Q64. Is anything half-finished or inconsistent that I should know about?**
Yes, be upfront about it. The README lists omitted features (attachments, merges, edits and deletes). There is no retention policy for events. The SQL functions in `src/sql/` can drift from the TypeORM code. Also check the README sentence about "advisory hash collisions" against the code, since the webhook section says no advisory locks are used. Fix or remove it before the interview.

---

## 13. AI usage

**Q65. Did you use AI?**
Yes, and `AI_USAGE.md` says so. It helped with reading the brief, reviewing the scaffold, the schema and concurrency design, implementation, tests and docs. Commands and test output were used to verify what it produced. The providers were mocked, and no real credentials were used.

**Q66. How do you know the AI-generated code is correct?**
I treated it as a draft. I ran the integration tests against real Postgres, and I wrote regression tests for things that looked plausible but were wrong, like the date bug in Q52. I can explain every lock and constraint in the code, and I documented the assumptions.

**Q67. Give an example where AI was wrong.**
The `timestamp()` validator (Q52). It looked valid and passed on normal input, but accepted impossible dates. A failing test exposed it.

---

## 14. Curveballs and live-coding

**Q68. A duplicate webhook arrives while the first is still in its transaction. What does the second request do?**
It blocks on the `provider_states` row lock. When the first commits, the second finds the message, compares the payload and returns `duplicate: true`.

**Q69. Two agents assign the same conversation at once.**
Both take the location lock for assignment. The later one wins deterministically and both succeed. The lock also keeps `last_assigned_at` ordering consistent. If I needed "first writer wins", I'd add an optimistic version check.

**Q70. A provider sends the same ID from two different locations.**
Same ID with a different location or payload returns 409. The root issue is my assumption of globally unique IDs. For real providers I'd add a provider or account ID to the callback and key on `(provider_account, provider_message_id)`.

**Q71. Status callback arrives for a message that never exists.**
It sits in `provider_states` indefinitely. That is an orphan with no retention policy, so I'd add a TTL cleanup.

**Q72. The database goes down mid-request.**
The transaction rolls back and the client gets a generic 500, so the provider retries. Idempotency makes that retry safe. `GET /health` checks DB connectivity, so an orchestrator can restart or drain the instance.

**Q73. Why does `GET /conversations` return only `contactId` and not participant IDs?**
It keeps the summary small and stops the response from exposing both internal participant records. Clients get the mapped contact instead.

**Q74. How would you add a new channel, such as Telegram?**
Add an adapter in `channels.ts` that implements `normalize` and the identity kind, extend the channel enum and the DB `CHECK` constraint, and add a migration. The conversation key is channel-independent, so nothing else changes.

**Q75. Add "closed conversation reopens on inbound message." Where does it go?**
In `updateConversationForInbound`. While holding the conversation lock, set status to `open` if it is `closed`. The README says reopening is covered by tests, so check that it already exists before you answer.

---

### Last-minute checklist
- [ ] Re-run `npm run check` and make sure everything is green.
- [ ] Be able to draw the inbound transaction and lock order on a whiteboard.
- [ ] Re-read `src/webhook/webhook.storage.ts`, `src/inbox/storage.ts`, `src/inbox/send.worker.ts` and `src/inbox/events.service.ts`.
- [ ] Fix the README "advisory" sentence and check the constant-time token comparison.
- [ ] Be ready to say what you wrote and what AI wrote.
