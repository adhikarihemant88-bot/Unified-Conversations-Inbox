import type { PoolClient } from 'pg';
import { advance, type DeliveryStatus } from '../inbox/domain';
import { event, messageSelect } from '../inbox/storage';

export async function providerLock(c: PoolClient, id: string): Promise<void> {
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('provider:' || $1, 0))",
    [id],
  );
}

export async function applyStatus(
  c: PoolClient,
  providerId: string,
  incoming: DeliveryStatus,
  time: string,
): Promise<void> {
  // Caller holds providerLock, including when no message exists yet.
  const old = await c.query<{ status: DeliveryStatus }>(
    'SELECT status FROM provider_states WHERE provider_message_id=$1',
    [providerId],
  );
  const status = old.rows[0] ? advance(old.rows[0].status, incoming) : incoming;
  await c.query(
    `INSERT INTO provider_states(provider_message_id,status,event_at) VALUES ($1,$2,$3)
    ON CONFLICT(provider_message_id) DO UPDATE SET status=EXCLUDED.status,
    event_at=CASE WHEN provider_states.status<>EXCLUDED.status THEN EXCLUDED.event_at ELSE provider_states.event_at END`,
    [providerId, status, time],
  );
  const found = await c.query<{
    id: string;
    location_id: string;
    status: DeliveryStatus;
  }>(
    'SELECT id,location_id,status FROM messages WHERE provider_message_id=$1 FOR UPDATE',
    [providerId],
  );
  const message = found.rows[0];
  if (!message) return;
  const next = advance(message.status, status);
  if (next === message.status) return;
  await c.query('UPDATE messages SET status=$2 WHERE id=$1', [
    message.id,
    next,
  ]);
  const { rows } = await c.query(`${messageSelect} WHERE id=$1`, [message.id]);
  await event(c, message.location_id, 'message.status', rows[0]);
}
