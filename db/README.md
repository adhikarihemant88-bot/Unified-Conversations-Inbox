# Database

This folder contains the PostgreSQL schema for Unified Conversations Inbox.
The application migration is [`001_init.sql`](./001_init.sql), which creates the
tables, constraints, and indexes used by the API, webhook handlers, and message
worker. The schema is applied transactionally with `npm run db:migrate`; see the
project [README](../README.md) for database setup.

## Tables

| Table | Purpose |
| --- | --- |
| `locations` | Defines inbox locations. A location name is unique and is used by location-scoped APIs and webhooks. |
| `agents` | Stores global agent assignment targets. Agent names are unique after trimming and ignoring case; `last_assigned_at` supports assignment ordering. |
| `agent_assignment_lock` | Holds the single-row lock used to serialize concurrent agent assignment. |
| `contacts` | Stores participants within a location. Each contact belongs to one location. |
| `contact_identities` | Associates a contact with a phone number or email address. An identity value is unique per location and kind. |
| `conversations` | Stores one conversation per participant pair within a location, along with open/closed status, assignment, unread count, and latest-message summary fields. |
| `messages` | Stores inbound and outbound SMS, WhatsApp, and email messages, including provider ID, delivery status, timestamps, and content. |
| `provider_states` | Records provider status events by provider message ID so delivery-state updates can be tracked independently of message creation. |
| `send_jobs` | Tracks pending outbound message delivery work, retry attempts, and the next eligible attempt time. |
| `inbox_events` | Stores location-scoped JSON events for inbox updates and event replay. |
| `pagination_snapshots` | Stores location-scoped pagination snapshots with an expiration time. |

## Relationships and invariants

- Contacts, conversations, events, and pagination snapshots are location-scoped.
- A conversation references two distinct contacts in the same location. Their
  IDs are stored in ascending order, and the location/participant pair is unique.
- Messages reference their conversation and location together, preventing a
  message from being attached to a conversation in another location.
- Each message has a globally unique `provider_message_id`. Channels, directions,
  statuses, and non-negative unread counts are restricted by database checks.
- `send_jobs` has at most one row per message. Its attempt count is limited to
  three, and only pending jobs are indexed for due-time lookup.

The migration also creates indexes for conversation ordering/filtering, message
history and full-text body search, contact identity lookup, due send jobs, inbox
events, and snapshot expiration.
