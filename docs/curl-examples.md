# cURL examples for every API

Start the service after running `npm run db:migrate` and `npm run db:seed`. These examples use the seeded `loc_1` / `agent_1` account. No real SMS, WhatsApp or email provider is required.

Run this setup in your terminal first:

```sh
BASE_URL='http://localhost:3000'
AGENT_TOKEN='demo-agent-1-token'
WEBHOOK_TOKEN='replace-with-your-configured-WEBHOOK_TOKEN'
LOCATION_ID='loc_1'
```

Replace `WEBHOOK_TOKEN` with the value configured for your running server. Agent endpoints require the bearer token; webhook endpoints require `X-Webhook-Token`. Health requires neither.

## 1. Check health

`GET /health` — HTTP 200 when the database is reachable.

```sh
curl -sS "$BASE_URL/health"
```

## 2. Receive an inbound message

`POST /webhooks/inbound` — HTTP 200 for a new message. Each example uses a different provider ID; reuse returns HTTP 409 without adding another message or unread increment.

### SMS

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Token: $WEBHOOK_TOKEN" \
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
CONVERSATION_ID='paste-the-returned-conversation-UUID'
```

This is the conversation UUID, not `providerMessageId`.

### WhatsApp

```sh
curl -sS -X POST "$BASE_URL/webhooks/inbound" \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Token: $WEBHOOK_TOKEN" \
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
  -H "X-Webhook-Token: $WEBHOOK_TOKEN" \
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

With the demo seed in place, all three messages belong to the same contact and conversation: the seed explicitly links this phone and email. Unlinked phone/email addresses are not automatically merged.

## 3. List conversations

`GET /locations/:locationId/conversations` — HTTP 200. Sorted by latest message, newest first. Default limit is 25; allowed range is 1–100.

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode 'limit=25'
```

Filter by open/closed status and assigned agent:

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode 'status=open' \
  --data-urlencode 'assignedTo=agent_1' \
  --data-urlencode 'limit=10'
```

Conversations are initially unassigned; assign one with the patch endpoint before expecting it in an `assignedTo=agent_1` result.

For the next page of the **filtered** query, copy `data.nextCursor` when it is non-null:

```sh
CONVERSATIONS_CURSOR='paste-data.nextCursor-from-the-filtered-query'

curl -sS --get "$BASE_URL/locations/$LOCATION_ID/conversations" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode 'status=open' \
  --data-urlencode 'assignedTo=agent_1' \
  --data-urlencode 'limit=10' \
  --data-urlencode "cursor=$CONVERSATIONS_CURSOR"
```

Keep the same filters across pages. Stop when `nextCursor` is null. Snapshot cursors expire after 15 minutes; expired or mismatched cursors return HTTP 410.

## 4. Get messages in a conversation

`GET /conversations/:id/messages` — HTTP 200. Messages are chronological, oldest first.

```sh
curl -sS --get "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode 'limit=25'
```

Next page, when `data.nextCursor` is non-null:

```sh
MESSAGES_CURSOR='paste-data.nextCursor-from-the-messages-query'

curl -sS --get "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode 'limit=25' \
  --data-urlencode "cursor=$MESSAGES_CURSOR"
```

## 5. Send an outbound message

`POST /conversations/:id/messages` — HTTP 202. Returns a persisted `queued` message; the mock worker sends asynchronously and retries failures.

### SMS

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"sms","body":"Yes, the offer is valid till Friday!"}'
```

### WhatsApp

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"whatsapp","body":"Here are your offer details."}'
```

### Email

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"channel":"email","body":"Your offer is valid till Friday. Thank you!"}'
```

The contact must have a phone identity for SMS/WhatsApp or an email identity for email. Copy `data.providerMessageId` from an outbound response for the next endpoint:

```sh
PROVIDER_MESSAGE_ID='paste-the-returned-providerMessageId'
```

## 6. Receive a delivery status callback

`POST /webhooks/status` — HTTP 200. The callback timestamp must include a timezone.

```sh
curl -sS -X POST "$BASE_URL/webhooks/status" \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Token: $WEBHOOK_TOKEN" \
  --data-raw "{
    \"providerMessageId\": \"$PROVIDER_MESSAGE_ID\",
    \"status\": \"delivered\",
    \"timestamp\": \"2026-10-28T10:18:00Z\"
  }"
```

Change `status` to `read` to simulate a read receipt. Accepted values: `queued`, `sent`, `delivered`, `read`, `failed`. Status never moves backward; `failed` is terminal. Unknown provider IDs are retained for reconciliation when their message arrives. Mock send success produces `sent`; delivery/read callbacks are supplied through this endpoint.

## 7. Mark a conversation as read

`POST /conversations/:id/read` — HTTP 200. Resets unread count; does not change delivery receipt statuses.

```sh
curl -sS -X POST "$BASE_URL/conversations/$CONVERSATION_ID/read" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

## 8. Update a conversation

`PATCH /conversations/:id` — HTTP 200. Supply status, assignment, or both. Empty updates are rejected. The agent must belong to this location.

Assign to an agent:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"assignedTo":"agent_1"}'
```

Close the conversation:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"status":"closed"}'
```

Reopen and assign together:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"status":"open","assignedTo":"agent_1"}'
```

Unassign:

```sh
curl -sS -X PATCH "$BASE_URL/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{"assignedTo":null}'
```

A new inbound message automatically reopens a closed conversation. A duplicate webhook does not.

## 9. Search messages

`GET /locations/:locationId/messages/search` — HTTP 200. Full-text search within the authorized location, newest first.

```sh
curl -sS --get "$BASE_URL/locations/$LOCATION_ID/messages/search" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode 'q=offer' \
  --data-urlencode 'limit=25'
```

Next page:

```sh
SEARCH_CURSOR='paste-data.nextCursor-from-the-search-query'

curl -sS --get "$BASE_URL/locations/$LOCATION_ID/messages/search" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode 'q=offer' \
  --data-urlencode 'limit=25' \
  --data-urlencode "cursor=$SEARCH_CURSOR"
```

Keep the same `q` when continuing a search snapshot.

## 10. Subscribe to real-time events

`GET /locations/:locationId/events` — HTTP 200 with `text/event-stream`. Run this in a separate terminal with the setup variables defined. It stays connected until Ctrl+C.

```sh
curl -sS -N "$BASE_URL/locations/$LOCATION_ID/events" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Accept: text/event-stream'
```

Send messages or callbacks from another terminal to receive `message.new`, `message.status`, or `conversation.updated` events. Without a replay header, only events after subscription initialization are sent.

Reconnect after the last received numeric event ID:

```sh
LAST_EVENT_ID='0'

curl -sS -N "$BASE_URL/locations/$LOCATION_ID/events" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Accept: text/event-stream' \
  -H "Last-Event-ID: $LAST_EVENT_ID"
```

Use `0` to replay all retained events for this location, or the last received `id:` value to resume after it. This is an event ID, distinct from conversation and provider message IDs.

## Second location

The seeded second agent can access `loc_2`:

```sh
curl -sS "$BASE_URL/locations/loc_2/conversations" \
  -H 'Authorization: Bearer demo-agent-2-token'
```

Using the first agent's token on that location returns HTTP 403. Using the second agent's token on a conversation belonging to `loc_1` returns HTTP 404.
