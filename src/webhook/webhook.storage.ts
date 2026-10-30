import type { EntityManager } from 'typeorm';
import { Contact } from '../entities/contact.entity';
import { ContactIdentity } from '../entities/contact-identity.entity';
import { Conversation } from '../entities/conversation.entity';
import { Agent } from '../entities/agent.entity';
import { Location } from '../entities/location.entity';
import { Message } from '../entities/message.entity';
import { ProviderState } from '../entities/provider-state.entity';
import { advance, type DeliveryStatus } from '../inbox/domain';
import {
  event,
  lockAgentAssignments,
  markAgentAssigned,
  messageView,
  updateLastMessage,
} from '../inbox/storage';

export async function findOrCreateContact(
  manager: EntityManager,
  locationId: number, //"locationId": "loc_1",
  kind: ContactIdentity['kind'], //"channel": "sms",
  value: string, //"from": "+91 98765 43210",
): Promise<number> {
  const identities = manager.getRepository(ContactIdentity);
  const key = { locationId, kind, value };
  const existing = await identities.findOneBy(key);
  if (existing) return existing.contactId;

  const contacts = manager.getRepository(Contact);
  const contact = await contacts.save(contacts.create({ locationId }));
  await identities
    .createQueryBuilder()
    .insert()
    .values({ ...key, contactId: contact.id })
    .orIgnore()
    .execute();

  const identity = await identities.findOneByOrFail(key);
  // If another request won, remove only this transaction's unused new contact.
  if (identity.contactId !== contact.id)
    await contacts.delete({ id: contact.id, locationId });
  return identity.contactId;
}

export async function findOrCreateConversation(
  manager: EntityManager,
  locationId: number,
  firstContactId: number,
  secondContactId: number,
): Promise<Conversation> {
  const conversations = manager.getRepository(Conversation);
  const [participantAId, participantBId] = [
    firstContactId,
    secondContactId,
  ].sort((a, b) => a - b);
  const where = { locationId, participantAId, participantBId };
  const existing = await conversations.findOne({
    where,
    lock: { mode: 'pessimistic_write' },
  });
  if (existing) return existing;

  await manager.getRepository(Location).findOneOrFail({
    where: { id: locationId },
    lock: { mode: 'pessimistic_write' },
  });
  const afterLock = await conversations.findOne({
    where,
    lock: { mode: 'pessimistic_write' },
  });
  if (afterLock) return afterLock;

  const agents = manager.getRepository(Agent);
  await lockAgentAssignments(manager);
  const agent = await agents
    .createQueryBuilder('agent')
    .orderBy('agent.lastAssignedAt', 'ASC', 'NULLS FIRST')
    .addOrderBy('agent.id', 'ASC')
    .setLock('pessimistic_write')
    .getOne();
  if (agent) {
    await markAgentAssigned(manager, agent.id);
  }

  await conversations
    .createQueryBuilder()
    .insert()
    .values({ ...where, assignedTo: agent?.id ?? null })
    .orIgnore()
    .execute();
  return conversations.findOneOrFail({
    where,
    lock: { mode: 'pessimistic_write' },
  });
}

export async function updateConversationForInbound(
  manager: EntityManager,
  conversation: Conversation,
  sentAt: Date,
  messageId: number,
  body: string,
): Promise<Conversation> {
  // findOrCreateConversation holds the row lock until this transaction commits.
  conversation.unreadCount += 1;
  conversation.status = 'open';
  updateLastMessage(conversation, { id: messageId, sentAt, body });
  return manager.getRepository(Conversation).save(conversation);
}

export async function providerLock(
  manager: EntityManager,
  providerMessageId: string,
  time = new Date(),
): Promise<ProviderState> {
  const states = manager.getRepository(ProviderState);
  await states
    .createQueryBuilder()
    .insert()
    .values({ providerMessageId, status: 'queued', eventAt: time })
    .orIgnore()
    .execute();
  return states.findOneOrFail({
    where: { providerMessageId },
    lock: { mode: 'pessimistic_write' },
  });
}

export async function applyStatus(
  manager: EntityManager,
  providerMessageId: string,
  incoming: DeliveryStatus,
  time: Date,
): Promise<void> {
  // Caller holds the provider-state row lock, even before a message exists.
  const states = manager.getRepository(ProviderState);
  const state = await states.findOneByOrFail({ providerMessageId });
  const status = advance(state.status, incoming);
  if (status !== state.status) {
    state.status = status;
    state.eventAt = time;
    await states.save(state);
  }

  const messages = manager.getRepository(Message);
  const message = await messages.findOne({
    where: { providerMessageId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!message) return;
  const next = advance(message.status, status);
  if (next === message.status) return;
  message.status = next;
  await messages.save(message);
  await event(
    manager,
    message.locationId,
    'message.status',
    messageView(message),
  );
}
