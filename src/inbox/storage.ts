import type { PoolClient } from 'pg';

export async function event(
  c: PoolClient,
  location: string,
  type: string,
  payload: unknown,
): Promise<void> {
  // Serialize event ID allocation per location until commit. SSE cannot skip an
  // earlier allocated ID whose transaction commits after a later event.
  await c.query(
    `WITH locked AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended('events:' || $1, 0))
    )
    INSERT INTO inbox_events(location_id,type,payload)
    SELECT $1,$2,$3::jsonb FROM locked`,
    [location, type, JSON.stringify(payload)],
  );
}
export const messageColumns = `id, conversation_id AS "conversationId", provider_message_id AS "providerMessageId",
 channel, direction, sender AS "from", recipient AS "to", body, status, sent_at AS "sentAt", created_at AS "createdAt"`;
export const conversationColumns = `id, contact_id AS "contactId", status, assigned_to AS "assignedTo",
 unread_count AS "unreadCount", last_message_at AS "lastMessageAt", last_message_preview AS "lastMessagePreview"`;
export const messageSelect = `SELECT ${messageColumns} FROM messages`;
export const conversationSelect = `SELECT ${conversationColumns} FROM conversations`;
