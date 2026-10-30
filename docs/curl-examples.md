# cURL examples for every API

Start the service after running `npm run db:migrate` and `npm run db:seed`. These examples use the seeded `loc_1` location. The seed command prints generated global agent IDs; set `AGENT_ID` to the agent used for assignment examples. No real SMS, WhatsApp or email provider is required.

Run this setup in your terminal first:

```sh
BASE_URL='http://localhost:3000'
INBOX_TOKEN='replace-with-your-configured-INBOX_TOKEN'
AGENT_ID='paste-the-generated-agent-id'
WEBHOOK_TOKEN='replace-with-your-configured-WEBHOOK_TOKEN'
ADMIN_TOKEN='replace-with-your-configured-ADMIN_TOKEN'
LOCATION_ID='loc_1'
```

Set distinct random `INBOX_TOKEN`, `WEBHOOK_TOKEN`, and `ADMIN_TOKEN` values to match the server configuration. Every protected endpoint uses `Authorization: Bearer <token>` and accepts only its module's token. Location-scoped routes use their `locationId` path parameter; conversation-ID routes resolve location from the conversation. Health requires no token.

## 1. Create an agent

`POST /admin/agents` — HTTP 201. This endpoint requires `Authorization: Bearer $ADMIN_TOKEN`.

```sh
curl -sS -X POST "$BASE_URL/admin/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"name":"Support Agent"}'
```

The response contains the generated integer agent `id` and `name`. Use the integer ID in `assignedTo`; inbox APIs authenticate with the shared `INBOX_TOKEN`. Agent names are unique case-insensitively after trimming; a duplicate returns HTTP 409 and does not create another agent.

## 2. Check health

`GET /health` — HTTP 200 when the database is reachable.

```sh
curl -sS "$BASE_URL/health"
```

## 3. Receive an inbound message

`POST /webhooks/inbound` — HTTP 200 for a new message. Each example uses a different provider ID; reuse returns HTTP 409 without adding another message or unread increment.

### SMS

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
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

Copy `data.message.conversationId` from this response and set:

```sh
CONVERSATION_ID='paste-the-returned-conversation-id'
```

This is the generated integer conversation ID, not `providerMessageId`.

### WhatsApp

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
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

### Email

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
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

With the demo seed in place, all three messages belong to the same participant pair and conversation: the seed explicitly links phone and email identities for both participants. Swapping `from` and `to` with a new provider ID reuses this conversation at the same location. Changing the location or either participant creates a separate conversation. Unlinked phone/email addresses are not automatically merged.

## 4. List conversations

`GET /locations/:locationId/conversations` — HTTP 200. Sorted by latest message, newest first. Default limit is 25; allowed range is 1–100.

```sh
curl --location --request GET "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'limit=25'
```

Filter by open/closed status and assigned agent:

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'status=open' \
  --data-urlencode "assignedTo=$AGENT_ID" \
  --data-urlencode 'limit=10'
```

The response contains conversation summaries in `data`, with numeric `conversationId` and `contactId` values, `lastMessageChannel`, and root-level `nextCursor` and `hasMore` fields. It does not include participant IDs or message history.

For the next page of the **filtered** query, copy the root-level `nextCursor` when it is non-null:

```sh
CONVERSATIONS_CURSOR='paste-nextCursor-from-the-filtered-query'

curl --location --request GET "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'status=open' \
  --data-urlencode "assignedTo=$AGENT_ID" \
  --data-urlencode 'limit=10' \
  --data-urlencode "cursor=$CONVERSATIONS_CURSOR"
```

Keep the same filters across pages. Stop when `nextCursor` is null. Snapshot cursors expire after 15 minutes; expired or mismatched cursors return HTTP 410.

## 5. Get messages in a conversation

`GET /conversations/:id/messages` — HTTP 200. Messages are chronological, oldest first.

```sh
curl -sS --get "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'limit=25'
```

Next page, when `data.nextCursor` is non-null:

```sh
MESSAGES_CURSOR='paste-data.nextCursor-from-the-messages-query'

curl -sS --get "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'limit=25' \
  --data-urlencode "cursor=$MESSAGES_CURSOR"
```

## 6. Send an outbound message

`POST /conversations/:id/messages` — HTTP 202. Returns a persisted `queued` message; the mock worker sends asynchronously and retries failures.

### SMS

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"sms","body":"Yes, the offer is valid till Friday!"}'
```

### WhatsApp

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"whatsapp","body":"Here are your offer details."}'
```

### Email

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"email","body":"Your offer is valid till Friday. Thank you!"}'
```

The reply reverses the latest inbound sender and recipient. Both participants must have a phone identity for SMS/WhatsApp or an email identity for email. Copy `data.providerMessageId` from an outbound response for the next endpoint:

```sh
PROVIDER_MESSAGE_ID='paste-the-returned-providerMessageId'
```

## 7. Receive a delivery status callback

`POST /webhooks/status` — HTTP 200. The callback timestamp must include a timezone.

```sh
curl -sS -X POST "$BASE_URL/webhooks/status" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  --data-raw "{
    \"providerMessageId\": \"$PROVIDER_MESSAGE_ID\",
    \"status\": \"delivered\",
    \"timestamp\": \"2026-10-28T10:18:00Z\"
  }"
```

Change `status` to `read` to simulate a read receipt. Accepted values: `queued`, `sent`, `delivered`, `read`, `failed`. Status never moves backward; `failed` is terminal. Unknown provider IDs are retained for reconciliation when their message arrives. Mock send success produces `sent`; delivery/read callbacks are supplied through this endpoint.

## 8. Mark a conversation as read

`POST /conversations/:id/read` — HTTP 200. Resets unread count; does not change delivery receipt statuses.

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/read" \
  -H "Authorization: Bearer $INBOX_TOKEN"
```

## 9. Update a conversation

`PATCH /conversations/:id` — HTTP 200. Supply status, assignment, or both. Empty updates are rejected. Agents are global and may be assigned to any location.

Assign to an agent:

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

Reopen and assign together:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"status\":\"open\",\"assignedTo\":$AGENT_ID}"
```

Unassign:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"assignedTo":null}'
```

A new inbound message automatically reopens a closed conversation. A duplicate webhook does not.

## 10. Search messages

`GET /locations/:locationId/messages/search` — HTTP 200. Full-text search within the authorized location, newest first.

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/messages/search" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'q=offer' \
  --data-urlencode 'limit=25'
```

Next page:

```sh
SEARCH_CURSOR='paste-data.nextCursor-from-the-search-query'

curl -sS --get "$BASE_URL/locations/$LOCATION_ID/messages/search" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  --data-urlencode 'q=offer' \
  --data-urlencode 'limit=25' \
  --data-urlencode "cursor=$SEARCH_CURSOR"
```

Keep the same `q` when continuing a search snapshot.

## 11. Subscribe to real-time events

`GET /locations/:locationId/events` — HTTP 200 with `text/event-stream`. Run this in a separate terminal with the setup variables defined. It stays connected until Ctrl+C.

```sh
curl -sS -N "$BASE_URL/locations/$LOCATION_ID/events" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Accept: text/event-stream'
```

Send messages or callbacks from another terminal to receive `message.new`, `message.status`, or `conversation.updated` events. Without a replay header, only events after subscription initialization are sent.

Reconnect after the last received numeric event ID:

```sh
LAST_EVENT_ID='0'

curl -sS -N "$BASE_URL/locations/$LOCATION_ID/events" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'Accept: text/event-stream' \
  -H "Last-Event-ID: $LAST_EVENT_ID"
```

Use `0` to replay all retained events for this location, or the last received `id:` value to resume after it. This is an event ID, distinct from conversation and provider message IDs.

## Second location

The shared inbox token can access `loc_2`, and global agents can be assigned to conversations at either location:

```sh
curl -sS "$BASE_URL/locations/loc_2/conversations" \
  -H 'Authorization: Bearer $INBOX_TOKEN'
```
