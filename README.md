# Unified Conversations Inbox

NestJS + TypeScript + PostgreSQL backend for one conversation per participant pair per location across SMS, WhatsApp and email. Messages in either direction share the same conversation. Includes mocked providers, concurrent webhook deduplication, durable send retries, monotonic delivery statuses, snapshot pagination, location-isolated SSE and full-text search. No real channel accounts are needed.

## Run locally (beginner setup)

### What you need

- Node.js 22.15 or newer and npm. Use Node.js 24.9 or newer to run the Jest test suites.
- Docker Desktop with Docker Compose, or your own PostgreSQL 17+ database.
- A terminal opened in this repository's folder.

### 1. Install the project

If you have not cloned the project yet, run the following command. If you already have the project, skip the clone command and open Terminal in its folder:

```sh
git clone https://github.com/adhikarihemant88-bot/Unified-Conversations-Inbox.git
cd Unified-Conversations-Inbox
npm ci
```

### 2. Create local configuration

Copy the example configuration:

```sh
cp .env.example .env.local
```

Open `.env.local` in a text editor. For Docker-based local setup, keep its example `DATABASE_URL`. Set different random values for `INBOX_TOKEN`, `WEBHOOK_TOKEN`, and `ADMIN_TOKEN`; for example, run `openssl rand -hex 32` three times and paste each result into a different setting. Do not commit or share real credentials.

### 3. Start the database

Start Docker Desktop, wait until it is ready, then run:

```sh
docker compose up -d --wait db
```

If you already have a PostgreSQL 17+ server, put its connection URL in `.env.local` as `DATABASE_URL` and skip Docker. Use a development database because migrations create and change tables in the configured database. PostgreSQL is the only service required; Redis is not used.

### 4. Build, create the schema, and add demo data

Run these commands in order:

```sh
npm run build
npm run db:migrate
npm run db:seed
```

The build is needed because the seed script loads compiled application entities. The migration is safe to repeat and creates the schema for a fresh database. An older schema requires a separate data migration. The seed creates `loc_1` and `loc_2`, two global agents, and two linked demo participants at `loc_1`:

- Participant A: `+919876543210` / `customer@example.com`
- Participant B: `+918000000000` / `inbox@example.com`

The seed prints the generated integer IDs for `agent_1` and `agent_2`; use one of those values when setting `AGENT_ID` in the API examples.

### 5. Start the API

```sh
npm run start:dev
```

Keep this terminal open while using the API. It runs at `http://localhost:3000`; check `http://localhost:3000/health` in a browser to verify that the server and database are reachable. Press Ctrl+C to stop the server.

### Troubleshooting

- If Docker is unavailable, start Docker Desktop and retry the database command.
- If port 5432 is already in use, stop the other database or change the Docker port and `DATABASE_URL` to match.
- If a database command fails, check that PostgreSQL is running and `DATABASE_URL` is correct.
- If a request returns 401, check that the correct token is in `.env.local` and that the request uses `Authorization: Bearer <token>`.
- If seeding fails because compiled entities are missing, run `npm run build`.

### Common commands

```sh
npm run build
npm run start:prod
npm test -- --runInBand
npm run test:e2e
npm run check
```

## Database and runtime details

Set distinct random `INBOX_TOKEN`, `WEBHOOK_TOKEN`, and `ADMIN_TOKEN` values in `.env.local`, and optionally `INBOX_LOCATION_TOKENS` for per-location agent credentials. Every protected endpoint uses `Authorization: Bearer <token>`; each API group accepts only its matching environment token. The inbox token authenticates inbox requests, while location is taken from each endpoint's path/body or resolved from its conversation ID. If using an existing PostgreSQL server, set `DATABASE_URL` there and omit the Docker step. Migrations change the database you explicitly configure; use a development database. Existing environment variables take precedence over `.env.local`, which takes precedence over `.env`. Your existing environment files are not modified by this project.

`npm run db:migrate` applies the single `db/001_init.sql` schema transactionally and is safe to repeat. It creates the schema for a fresh database. Existing databases with an earlier schema require a separate data migration before using this version. `npm run db:seed` creates two demo locations and global agents, plus two participants at `loc_1`: `+919876543210` / `customer@example.com` and `+918000000000` / `inbox@example.com`. Each participant's phone and email identities are linked to their contact.

Location, agent, contact, conversation, message, event, and pagination snapshot IDs are generated integers. Agents are global assignment targets and are not tied to a location. The webhook's `locationId` value and the location path segment (for example `loc_1`) refer to the unique location name.

The seed command prints generated integer agent IDs; use those values for `assignedTo` and its filters. These are development fixtures. Authentication is handled by separate module bearer tokens in `.env.local`; the webhook token grants trusted provider access to all locations. In a real integration, verify provider signatures and derive location from the registered provider account.

Production build:

```sh
npm run build
npm run start:prod
```

The worker starts with the application. Set `WORKER_ENABLED=false` for an API-only process. Default port: 3000. `GET /health` checks database connectivity.

## Source layout

- [src/webhook/](./src/webhook/): inbound and status webhook controller/service, provider status/locking helpers, and webhook DTOs.
- [src/inbox/](./src/inbox/): conversation APIs, outbound sending/worker, pagination, search, real-time events and shared message/channel domain logic.
- [src/admin/](./src/admin/): admin APIs and agent creation.
- [src/common/](./src/common/): shared bearer authentication, validation decorators, and HTTP response/error handling.
- [src/health.controller.ts](./src/health.controller.ts): database health endpoint.

## API examples

The following walkthrough includes common requests. The [complete cURL reference](#complete-curl-reference) below includes every endpoint, all channels, pagination, assignment options, and SSE replay.

Create a global agent with `POST /admin/agents`, using the configured `ADMIN_TOKEN` as a bearer token. Send `{ "name": "Agent name" }`; the response includes the generated integer ID and name. Agent names are unique case-insensitively after trimming; an existing name returns HTTP 409 without creating another agent.

All JSON responses use `{ "status": 200, "message": "Success", "data": ... }`. Validation errors use HTTP 400, unauthorized requests 401, unknown locations or conversations 404, conflicting provider IDs 409, and expired/incompatible pagination cursors 410. Location-scoped endpoints take the location name from the route (or webhook payload); conversation-ID endpoints resolve location from the stored conversation. Unexpected errors return a generic HTTP 500 response; details stay in server logs. SSE uses standard event-stream framing.

Request bodies, path parameters and pagination/filter/search queries use class-based [inbox DTOs](./src/inbox/dto/) and [webhook DTOs](./src/webhook/dto/). A global `ValidationPipe` is registered through `APP_PIPE` in [AppModule](./src/app.module.ts), so production and integration tests use identical validation. It transforms DTO instances, rejects unknown fields and validates positive integer IDs, required nonblank strings, enums, calendar timestamps and cursors. Strings have no arbitrary DTO length limits. Query limits explicitly convert decimal strings to integers between 1 and 100; implicit coercion is disabled. On patches, omitted fields preserve existing values, `assignedTo: null` unassigns, and empty updates or `status: null` are rejected. Phone/email normalization, authorization, status progression and transaction invariants stay in services/database constraints.

Inbound webhook:

```sh
curl -X POST http://localhost:3000/webhooks/inbound \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer WEBHOOK_TOKEN' \
  -d '{"providerMessageId":"SM_abc123","locationId":"loc_1","channel":"sms","from":"+91 98765 43210","to":"+91 80000 00000","body":"Is the offer still valid?","sentAt":"2026-10-28T10:15:00Z"}'
```

The first response contains `{ duplicate: false, message }`. A provider retry that replays the same payload returns HTTP 200 with `{ duplicate: true, message }` (the originally stored message), so providers stop retrying; nothing is stored, counted, reopened or published a second time. Reusing a `providerMessageId` with a different payload or location returns HTTP 409 (`Duplicate providerMessageId`).

List conversations (use the agent ID printed by `npm run db:seed`):

```sh
1='paste-the-generated-agent-id'
curl --get "http://localhost:3000/locations/loc_1/conversations?limit=25&status=open&assignedTo=1" \
  -H 'Authorization: Bearer INBOX_TOKEN'
```

Filters are optional. Omit both to list all conversations. The response contains a flat `data` array of conversation summaries, plus root-level `nextCursor` and `hasMore` fields:

```json
{
  "data": [
    {
      "conversationId": 502,
      "contactId": 102,
      "lastMessageChannel": "email",
      "lastMessagePreview": "Please share the details",
      "lastMessageAt": "2026-10-28T10:20:00.000Z",
      "status": "open",
      "assignedTo": null,
      "unreadCount": 1
    },
    {
      "conversationId": 501,
      "contactId": 101,
      "lastMessageChannel": "whatsapp",
      "lastMessagePreview": "Any update?",
      "lastMessageAt": "2026-10-28T10:15:00.000Z",
      "status": "open",
      "assignedTo": 1,
      "unreadCount": 2
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

Each summary includes the latest message channel; participant IDs and full message histories are not returned. Use `data[0].conversationId` as the integer conversation ID for the following requests. It is distinct from `providerMessageId`.

```sh
# Replace CONVERSATION_ID with a returned integer ID.
curl 'http://localhost:3000/conversations/CONVERSATION_ID/messages?limit=25' \
  -H 'Authorization: Bearer INBOX_TOKEN'

curl -X POST http://localhost:3000/conversations/CONVERSATION_ID/messages \
  -H 'Authorization: Bearer INBOX_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"channel":"whatsapp","body":"Yes, valid till Friday!"}'

curl -X POST http://localhost:3000/conversations/CONVERSATION_ID/read \
  -H 'Authorization: Bearer INBOX_TOKEN'

curl -X PATCH http://localhost:3000/conversations/CONVERSATION_ID \
  -H 'Authorization: Bearer INBOX_TOKEN' \
  -H 'Content-Type: application/json' \
  -d "{\"status\":\"closed\",\"assignedTo\":1}"
```

Outbound requests return HTTP 202 and the persisted `queued` message. Set `assignedTo` to `null` to unassign. A reply reverses the sender and recipient of the latest inbound message. When changing channels, both participants must have an identity for the requested channel; otherwise sending returns 400. Participant A/B order is only used to identify the conversation and does not determine message direction.

Delivery callback (use the outbound response's `providerMessageId`):

```sh
curl -X POST http://localhost:3000/webhooks/status \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer WEBHOOK_TOKEN' \
  -d '{"providerMessageId":"mock_REPLACE_WITH_RETURNED_ID","status":"delivered","timestamp":"2026-10-28T10:16:00Z"}'
```

The mock send operation advances status to `sent` on success. Delivery and read acknowledgments are simulated through the status endpoint. An agent marking a conversation read resets its unread count; it does not fabricate a channel delivery/read receipt.

Real-time subscription:

```sh
curl -N http://localhost:3000/locations/loc_1/events \
  -H 'Authorization: Bearer INBOX_TOKEN'
```

Optionally add `?agentId=<id>` to announce that agent's presence. Events: `message.new` (message and updated conversation), `message.status` (updated message), and `conversation.updated`. Reconnect with `Last-Event-ID: <last received event ID>` to replay later events. Without that header, the stream starts at the current location watermark. Use authenticated `fetch` streaming or an SSE client that supports headers; native browser `EventSource` does not allow a custom Authorization header.

Typing indicators and presence (optional bonus implemented):

```sh
curl -X POST http://localhost:3000/locations/loc_1/typing \
  -H 'Authorization: Bearer INBOX_TOKEN' -H 'Content-Type: application/json' \
  -d "{\"conversationId\":CONVERSATION_ID,\"agentId\":1,\"typing\":true}"

curl http://localhost:3000/locations/loc_1/presence -H 'Authorization: Bearer INBOX_TOKEN'
```

Subscribers of the same location's SSE stream receive `typing` (`conversationId`, `agentId`, `typing`) and, for streams opened with `?agentId=`, `presence.online` / `presence.offline` plus an initial `presence.snapshot`. These events are ephemeral: they carry no `id:` line, are not stored and are not replayed. They are fanned out in memory, so they only reach streams on the same API instance; multi-instance fan-out would use Postgres `LISTEN/NOTIFY` or the broker from the design note.

Search (optional bonus implemented):

```sh
curl 'http://localhost:3000/locations/loc_1/messages/search?q=offer&limit=25' \
  -H 'Authorization: Bearer INBOX_TOKEN'
```

Search uses PostgreSQL full-text matching with the `simple` dictionary, newest first. It supports snapshot cursors too. This is token matching, not arbitrary substring/fuzzy search.

## Complete cURL reference

The examples below work against the local server from the setup guide. Use a second terminal while `npm run start:dev` is running. Set the token values to exactly what you put in `.env.local`; set `AGENT_ID` to the integer printed by `npm run db:seed`.

```sh
BASE_URL='http://localhost:3000'
LOCATION_ID='loc_1'
INBOX_TOKEN='paste-your-INBOX_TOKEN-here'
WEBHOOK_TOKEN='paste-your-WEBHOOK_TOKEN-here'
ADMIN_TOKEN='paste-your-ADMIN_TOKEN-here'
AGENT_ID='paste-agent_1-integer-from-seed-output'
```

### Health and agent administration

Health does not require authentication:

```sh
curl -sS "$BASE_URL/health"
```

Create a global agent with the admin token (optional; the seed already creates two):

```sh
curl -sS -X POST "$BASE_URL/admin/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"name":"Support Agent"}'
```

### Inbound webhooks

Use a unique provider message ID for each new request. These examples use seeded identities, so all three channels resolve to the same contact pair at `loc_1`.

**SMS**

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "providerMessageId": "SM_curl_001",
    "locationId": "loc_1",
    "channel": "sms",
    "from": "+91 98765 43210",
    "to": "+91 80000 00000",
    "body": "Is the offer still valid?",
    "sentAt": "2026-10-28T10:15:00Z"
  }'
```

**WhatsApp**

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "providerMessageId": "WA_curl_001",
    "locationId": "loc_1",
    "channel": "whatsapp",
    "from": "whatsapp:+919876543210",
    "to": "whatsapp:+918000000000",
    "body": "Following up on WhatsApp about the offer.",
    "sentAt": "2026-10-28T10:16:00Z"
  }'
```

**Email**

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "providerMessageId": "EM_curl_001",
    "locationId": "loc_1",
    "channel": "email",
    "from": "Customer@Example.com",
    "to": "inbox@example.com",
    "body": "Please email the offer details.",
    "sentAt": "2026-10-28T10:17:00Z"
  }'
```

To try a retry, send the exact same request again: it returns the original message with `duplicate: true` and does not create a second message. Reusing an ID with a different payload returns HTTP 409.

### Conversations and pagination

List conversations at a location (filters are optional):

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'limit=25'
```

Filter by status and assigned agent:

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'status=open' \
  --data-urlencode "assignedTo=$AGENT_ID" \
  --data-urlencode 'limit=10'
```

Copy the response's root-level `nextCursor` for the next page, keeping the filters the same:

```sh
CONVERSATIONS_CURSOR='paste-nextCursor-from-the-previous-response'

curl -sS --get "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'status=open' \
  --data-urlencode "assignedTo=$AGENT_ID" \
  --data-urlencode 'limit=10' \
  --data-urlencode "cursor=$CONVERSATIONS_CURSOR"
```

Copy a `conversationId` from a response and set it before using conversation endpoints:

```sh
CONVERSATION_ID='paste-conversationId-here'
```

Get messages for that conversation (oldest first):

```sh
curl -sS --get "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'limit=25'
```

For another page, copy `data.nextCursor` and use the same limit:

```sh
MESSAGES_CURSOR='paste-data.nextCursor-from-the-previous-response'

curl -sS --get "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'limit=25' \
  --data-urlencode "cursor=$MESSAGES_CURSOR"
```

Pagination cursors expire after 15 minutes. If a cursor returns HTTP 410, start a new listing.

### Outbound messages and delivery status

The mock worker processes outbound messages asynchronously. The initial response is HTTP 202 and contains the queued message. Both participants need an identity for the selected channel.

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"sms","body":"Yes, the offer is valid till Friday!"}'

curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"whatsapp","body":"Here are your offer details."}'

curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"email","body":"Your offer is valid till Friday. Thank you!"}'
```

Copy `data.providerMessageId` from an outbound response, then simulate a delivery callback:

```sh
PROVIDER_MESSAGE_ID='paste-providerMessageId-here'

curl -sS -X POST "$BASE_URL/webhooks/status" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw "{
    \"providerMessageId\": \"$PROVIDER_MESSAGE_ID\",
    \"status\": \"delivered\",
    \"timestamp\": \"2026-10-28T10:18:00Z\"
  }"
```

Use `queued`, `sent`, `delivered`, `read`, or `failed` as the callback status. Include a timezone in the timestamp. Status never moves backward, and `failed` is terminal.

### Assignment, status, and unread count

Assign the conversation to the seeded agent:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"assignedTo\":$AGENT_ID}"
```

Close the conversation:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"status":"closed"}'
```

Reopen and assign in one request:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"status\":\"open\",\"assignedTo\":$AGENT_ID}"
```

Unassign by setting the agent to `null`:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"assignedTo":null}'
```

Mark the conversation as read:

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/read" \
  -H "Authorization: Bearer $INBOX_TOKEN"
```

Marking a conversation read resets its unread count; it does not change message delivery receipts. A new inbound message reopens a closed conversation.

### Search

Search a location's messages (full-text word/token search, newest first):

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/messages/search" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'q=offer' \
  --data-urlencode 'limit=25'
```

For the next page, copy `data.nextCursor` and keep the query unchanged:

```sh
SEARCH_CURSOR='paste-data.nextCursor-from-the-previous-response'

curl -sS --get "$BASE_URL/locations/$LOCATION_ID/messages/search" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'q=offer' \
  --data-urlencode 'limit=25' \
  --data-urlencode "cursor=$SEARCH_CURSOR"
```

### Server-sent events (SSE), typing, and presence

This stream stays connected until Ctrl+C. Run it in a separate terminal; other API requests can publish events while it is open:

```sh
curl -sS -N "$BASE_URL/locations/$LOCATION_ID/events" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Accept: text/event-stream'
```

To resume after an event, set `LAST_EVENT_ID` to the last received numeric `id:` value. Use `0` to replay retained events from the beginning:

```sh
LAST_EVENT_ID='0'

curl -sS -N "$BASE_URL/locations/$LOCATION_ID/events" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Accept: text/event-stream' \
  -H "Last-Event-ID: $LAST_EVENT_ID"
```

Add `?agentId=$AGENT_ID` to the events URL to announce agent presence on that stream. Native browser `EventSource` cannot send the Authorization header; use `curl` or an authenticated streaming client.

Send a typing indicator:

```sh
curl -sS -X POST "$BASE_URL/locations/$LOCATION_ID/typing" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"conversationId\":$CONVERSATION_ID,\"agentId\":$AGENT_ID,\"typing\":true}"
```

Get the currently connected agents:

```sh
curl -sS "$BASE_URL/locations/$LOCATION_ID/presence" \
  -H "Authorization: Bearer $INBOX_TOKEN"
```

Typing and presence notifications are ephemeral: they are not stored or replayed. Presence snapshots/online/offline events are sent to streams opened with `agentId`.

### Request a different location

The seeded inbox token can access both locations; agents are global, but conversations are location-scoped:

```sh
curl -sS "$BASE_URL/locations/loc_2/conversations" \
  -H "Authorization: Bearer $INBOX_TOKEN"
```

## Data model and indexes

The schema is defined by the initialization migration in [db/](./db/).

| Table                  | Purpose / guarantees                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locations`            | Generated integer primary key and unique name; incoming `locationId` values are stored as names.                                                                                                                                    |
| `agents`               | Generated integer primary key, name, and last-assigned timestamp; agents are global and can be assigned to conversations at any location.                                                                                           |
| `contacts`             | Generated integer ID for each canonical participant within one location.                                                                                                                                                            |
| `contact_identities`   | Unique `(location_id, kind, value)`; phone/email identities reference the same integer contact ID explicitly.                                                                                                                       |
| `conversations`        | Generated integer primary key; unique `(location_id, participant_a_id, participant_b_id)` with numerically sorted contact IDs and location-scoped foreign keys for both participants; nonnegative unread count; open/closed status. |
| `messages`             | Generated integer primary key; unique `provider_message_id`; checked channel/direction/status; composite location/conversation foreign key.                                                                                         |
| `provider_states`      | Status state and per-provider row lock, including callbacks received before message persistence.                                                                                                                                    |
| `send_jobs`            | Persistent attempts, pending/done state, and retry schedule.                                                                                                                                                                        |
| `inbox_events`         | Generated integer primary key and transactional event log for location-filtered replay.                                                                                                                                             |
| `pagination_snapshots` | Generated integer primary key; location/query-scoped ordered result snapshots, expiring after 15 minutes.                                                                                                                           |

Indexes cover conversation listing by location/latest activity, status/assignment filters, contact identity lookup, chronological message history, due pending jobs, location/event ID polling, snapshot expiry, and GIN full-text search. Primary and unique constraints supply the supporting identity/idempotency indexes. Composite foreign keys prevent accidental cross-location references even in direct SQL writes.

Phone input must include a country code; spaces, parentheses, dots, hyphens and a `whatsapp:` prefix are normalized. Email is trimmed and lowercased. We do not guess a country code or infer that an unlinked email and phone belong to one person. The demo seed links phone/email identities for both participants; unknown addresses create separate contacts until explicitly linked. A contact management/merge API is outside the assignment scope.

## Concurrency and ordering

### Inbound idempotency and counters

Inbound and status webhooks use TypeORM entities and repositories in one transaction. The data source maps the existing tables with `synchronize: false`; the migration script still owns the schema. It also supplies the connection used by existing inbox and worker transactions.

An inbound webhook finds the location by `name` using the supplied `locationId` value. If missing, it inserts only the name and lets PostgreSQL generate the numeric primary key. All contacts, conversations, messages and events reference that generated ID. Concurrent inserts ignore a conflicting location name, and location creation rolls back with the rest of the webhook if processing fails.

Both `from` and `to` resolve to contacts using `findOneBy` with `(locationId, kind, normalizedValue)`. Addresses are resolved sequentially in sorted order so simultaneous A-to-B and B-to-A messages cannot wait on newly created identities in opposite orders. If missing, insert a contact and its identity. The unique identity key handles concurrent first messages: TypeORM's insert builder ignores a conflicting identity, then a fresh lookup returns the winning contact. The losing transaction deletes only its own unused new contact. Existing contacts are returned immediately. There are no identity advisory locks or CTEs.

Conversation lookup numerically sorts the two generated contact IDs, then uses `findOne` by `(locationId, participantAId, participantBId)` and inserts a conversation if missing. A newly created conversation is assigned to the global agent with the oldest `last_assigned_at`; agents with no prior assignments are first, with agent ID breaking ties. A location-row lock serializes new-conversation assignment and manual assignment updates, preventing concurrent inbound requests from selecting the same stale oldest agent. Assignment timestamps are ordered across all agents. New messages on an existing conversation do not reassign it. If there are no agents, a new conversation remains unassigned. Sender/recipient order and channel are not part of the conversation key. A-to-B and B-to-A messages share one conversation at `loc_1`; the same pair has a different conversation at `loc_2`. A-to-C is also a separate conversation at `loc_1`. Internal conversation records and event payloads retain the participant pair; the conversation-list summary response omits those IDs and exposes `contactId` with the mapped contact identities instead. The existing unique constraint handles concurrent first messages; a conflicting insert is ignored and followed by a fresh lookup of the conversation created by the other request. A TypeORM pessimistic write lock keeps updates to that conversation serialized with incoming messages and mark-as-read.

The existing unread/preview behavior is a separate step after find-or-create. It updates the locked entity and saves it through its repository. The webhook flow, including message and event writes, contains no raw SQL. TypeORM's insert builder is used only where concurrent requests need an insert that ignores a unique-key conflict.

Only a successfully committed new inbound message increments unread count. Contact/conversation creation, message insertion, the counter/preview update and event insertion commit or roll back together. Old `sentAt` values cannot replace newer preview/activity metadata; generated message IDs break equal-time ties. Mark-as-read locks the same conversation row. Messages ordered before that reset are read; messages ordered after it stay unread. This defines the outcome of concurrent read/ingestion requests without lost increments.

### Status ordering and early callbacks

The ordering is `queued < sent < delivered < read < failed`. `failed` is terminal, as the brief allows failure at any point. Timestamp is retained as provider metadata, not used to regress lifecycle state. Late `sent` after `delivered`, duplicate callbacks, and worker completion after a callback cannot lower status.

Callbacks, ingestion and the send worker hold the same TypeORM pessimistic write lock on a `provider_states` row. An insert that ignores conflicts creates the row at `queued` if needed, so even a provider ID with no message can be locked. A callback with no corresponding message persists its status there; ingestion reconciles it while holding that lock. Inbound messages begin as `delivered` unless an earlier callback already establishes a later state. The unique message constraint remains the final deduplication boundary.

Provider IDs are assumed globally unique because the specified status payload contains no channel or location. Real providers with overlapping ID namespaces require a provider/account identifier in the callback contract and composite deduplication keys.

### Outbound queue and retries

Outbound message, send job, preview and event commit together. The worker claims jobs with `FOR UPDATE SKIP LOCKED`, so multiple workers cannot process a job simultaneously. The mock receives a stable, preallocated provider ID, fails with probability `MOCK_FAILURE_RATE` (default 0.2), and makes at most three total attempts. Backoff is `RETRY_BASE_MS`, then twice that (defaults: 1s and 2s). Only exhaustion marks the message failed.

Pending work and attempt counts survive application restarts. The mock runs while the job transaction is held; this keeps the exercise small. A real slow provider should use leased jobs, request timeouts, and provider-side idempotency using the stable ID. A crash between an external send and database commit can otherwise repeat the external action; database transactions cannot provide exactly-once delivery to a remote service.

### Stable pagination

A cursor contains the generated integer snapshot ID and next position. The first request materializes an ordered result in one database statement. Later requests page through that frozen result; snapshots are bound to location, resource and filters. Page size is 1–100 (default 25). Snapshots expire in 15 minutes; restart listing after HTTP 410.

Messages use `(sent_at,id)` ordering; conversations use `(last_message_at,id)` descending. A simple live keyset is insufficient for conversations because a new message moves an existing conversation ahead of the cursor. Frozen snapshots prevent both skipped rows and duplicates, including late messages with older timestamps. Messages/events arriving after snapshot creation appear through SSE and a fresh listing; statuses/counters in existing snapshots remain frozen too.

Trade-off: snapshot creation stores the entire result and scales with inbox/history size. Worker housekeeping deletes expired snapshots roughly every minute when idle (less frequently under load). For large histories, use versioned ordering or an external snapshot cache, quotas and explicit pagination sessions.

### Location-isolated real-time updates

Each API module uses its own bearer token (`INBOX_TOKEN`, `WEBHOOK_TOKEN`, or `ADMIN_TOKEN`). The shared inbox token grants access across locations (operator use). Agents should instead use a location-scoped token from `INBOX_LOCATION_TOKENS` (`loc_1:tokenA,loc_2:tokenB`): `LocationScopeGuard` rejects with HTTP 403 any request whose path location, or whose conversation's stored location, differs from the token's, including the SSE stream. Location-scoped routes use the location name from the path; conversation-ID routes resolve the location from the stored conversation. Events remain filtered by the requested location and are stored in the same transaction as their state change, so no uncommitted or rolled-back state is published.

SSE polls the shared event log every 500ms and replays by event ID. Event writers use a TypeORM `for_no_key_update` lock on the location row before allocating an event ID, serializing allocation per location until commit. This lock permits foreign-key checks while ensuring an earlier uncommitted event ID cannot later appear behind a location's delivered watermark. Heartbeats run about every 15 seconds. Slow consumers disconnect and can resume with `Last-Event-ID`. Shutdown closes streams. Multiple API instances can use this shared database log without sticky sessions or an in-memory broker.

## Tests

```sh
npm test -- --runInBand  # domain and normalization tests
npm run test:e2e         # actual PostgreSQL + HTTP + SSE integration tests
npm run check           # build, type-aware lint, unit tests, integration tests
```

Integration tests automatically start and stop a disposable local PostgreSQL binary using the pinned development-only `embedded-postgres` dependency. They never read application `.env` credentials. For environments where native binaries cannot run (including root-only containers), provide an explicit disposable server:

```sh
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/inbox_test npm run test:e2e
```

The suite creates a random private schema, runs migrations there, and removes only that schema afterward. Database permissions must permit schema creation. No existing application tables are truncated. If your package manager disables dependency postinstall scripts, enable the platform package's hydration script or use `TEST_DATABASE_URL`.

Coverage includes concurrent duplicates, 50 simultaneous first messages in both directions, participant-pair/location separation, cross-channel identities for both participants, reply direction, early/reordered/terminal statuses, read/reset races, reopening, late-message previews, snapshots under insertion/reordering, outbound parallel claims/backoff/exhaustion/recovery, transaction rollback, database-level tenant constraints, HTTP authorization and live SSE isolation/replay.

## Trade-offs and improvements

- Static seeded bearer credentials keep authentication testable; production needs credential lifecycle, agent authorization policy and provider signatures.
- Database locks favor correctness for this workload. Advisory hash collisions only reduce concurrency; they do not weaken uniqueness constraints.
- Events and orphan provider states currently have no automatic retention policy. Add retention, replay-expiry responses, monitoring and storage quotas before sustained production traffic.
- Outbound request retries can create multiple queued messages; client request idempotency keys would prevent that. Required webhook idempotency is implemented.
- Providers are mocked. Attachment support, contact merges, message edits/deletes and are omitted.
- Add rate limits, pagination resource quotas, structured redacted logs, metrics, database backups, connection budgets and production deployment configuration.

### Design note: 10,000 inbound messages/second

Partition ingestion by location/participant pair to preserve per-conversation ordering while processing unrelated conversations in parallel. Acknowledge only after durable acceptance (database commit or a durable broker). Batch writes, partition large message/event tables, tune indexes and connection pools, and enforce provider deduplication on the durable write path. A single hot conversation still requires serialized counter/order updates; tenant partitioning alone cannot remove that contention.

Replace per-connection database polling with event-log/outbox consumers and a broker partitioned by location. Dedicated SSE gateways authenticate location subscriptions and fan out committed events across instances. Retain durable event IDs for reconnect/replay and monitor lag/backpressure. Leased outbound jobs allow slow network calls outside transactions; provider idempotency handles the send/commit crash window. Replace full-result JSON snapshots with bounded/versioned pagination sessions and cache suitable inbox projections.

See [AI_USAGE.md](./AI_USAGE.md) for the AI-assisted workflow and a real regression caught and fixed during implementation.
