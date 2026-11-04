import type { EntityManager } from 'typeorm';
import { InboxEvent } from '../entities/inbox-event.entity';
import { Agent } from '../entities/agent.entity';
import { Location } from '../entities/location.entity';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';

export async function event(
  manager: EntityManager,
  location: number,
  type: string,
  payload: unknown,
): Promise<void> {
  await lockLocation(manager, location, 'for_no_key_update');
  const events = manager.getRepository(InboxEvent);
  await events.save(events.create({ locationId: location, type, payload }));
}

export async function lockLocation(
  manager: EntityManager,
  location: number,
  mode: 'pessimistic_write' | 'for_no_key_update' = 'pessimistic_write',
): Promise<void> {
  // SSE cannot skip an earlier event whose transaction commits after a later one.
  await manager.getRepository(Location).findOneOrFail({
    where: { id: location },
    lock: { mode },
  });
}

// Callers hold the location row lock (lockLocation), which serializes
// assignment decisions within a location; agents belong to exactly one location.
export async function markAgentAssigned(
  manager: EntityManager,
  locationId: number,
  agentId: number,
): Promise<void> {
  const agents = manager.getRepository(Agent);
  const latest = await agents.findOne({
    where: { locationId },
    order: { lastAssignedAt: 'DESC' },
    select: { lastAssignedAt: true },
  });
  const assignedAt = new Date(
    Math.max(Date.now(), (latest?.lastAssignedAt?.getTime() ?? 0) + 1),
  );
  await agents.update(
    { id: agentId, locationId },
    { lastAssignedAt: assignedAt },
  );
}

export function conversationView(conversation: Conversation) {
  const {
    id,
    participantAId,
    participantBId,
    status,
    assignedTo,
    unreadCount,
    lastMessageAt,
    lastMessagePreview,
  } = conversation;
  return {
    id,
    participantAId,
    participantBId,
    status,
    assignedTo,
    unreadCount,
    lastMessageAt,
    lastMessagePreview,
  };
}

export function messageView(message: Message) {
  const {
    id,
    conversationId,
    providerMessageId,
    channel,
    direction,
    from,
    to,
    body,
    status,
    sentAt,
    createdAt,
  } = message;
  return {
    id,
    conversationId,
    providerMessageId,
    channel,
    direction,
    from,
    to,
    body,
    status,
    sentAt,
    createdAt,
  };
}

export function updateLastMessage(
  conversation: Conversation,
  message: Pick<Message, 'id' | 'sentAt' | 'body'>,
): void {
  const previousTime = conversation.lastMessageAt?.getTime();
  const sentTime = message.sentAt.getTime();
  if (
    previousTime === undefined ||
    sentTime > previousTime ||
    (sentTime === previousTime &&
      (conversation.lastMessageId === null ||
        message.id > conversation.lastMessageId))
  ) {
    conversation.lastMessageAt = message.sentAt;
    conversation.lastMessageId = message.id;
    conversation.lastMessagePreview = message.body.slice(0, 160);
  }
}

export const messageColumns = `id, conversation_id AS "conversationId", provider_message_id AS "providerMessageId",
 channel, direction, sender AS "from", recipient AS "to", body, status, sent_at AS "sentAt", created_at AS "createdAt"`;
export const conversationColumns = `id, participant_a_id AS "participantAId", participant_b_id AS "participantBId", status, assigned_to AS "assignedTo",
 unread_count AS "unreadCount", last_message_at AS "lastMessageAt", last_message_preview AS "lastMessagePreview"`;
export const messageSelect = `SELECT ${messageColumns} FROM messages`;
export const conversationSelect = `SELECT ${conversationColumns} FROM conversations`;
