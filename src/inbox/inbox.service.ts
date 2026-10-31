import {
  BadRequestException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { In, type EntityManager } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { ContactIdentity } from '../entities/contact-identity.entity';
import { Conversation as ConversationEntity } from '../entities/conversation.entity';
import { Location } from '../entities/location.entity';
import { Message } from '../entities/message.entity';
import { PaginationSnapshot } from '../entities/pagination-snapshot.entity';
import { SendJob } from '../entities/send-job.entity';
import { DatabaseService } from '../utils/database.service';
import { Channels } from './channels';
import { EventsService } from './events.service';
import type { TypingDto } from './dto/typing.dto';
import type { SendMessageDto } from './dto/send-message.dto';
import type { UpdateConversationDto } from './dto/update-conversation.dto';
import type {
  ConversationQueryDto,
  PaginationDto,
  SearchMessagesDto,
} from './dto/pagination.dto';
import {
  conversationView,
  event,
  lockLocation,
  markAgentAssigned,
  messageView,
  updateLastMessage,
} from './storage';

@Injectable()
export class InboxService {
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: Channels,
    private readonly events: EventsService,
  ) {}

  async resolveLocationId(name: string): Promise<number> {
    const location = await this.db.ormTransaction((manager) =>
      manager.getRepository(Location).findOneBy({ name }),
    );
    if (!location) throw new NotFoundException('Location not found');
    return location.id;
  }

  async typing(locationName: string, data: TypingDto) {
    const location = await this.resolveLocationId(locationName);
    const conversation = await this.db
      .getRepository(ConversationEntity)
      .findOneBy({ id: data.conversationId, locationId: location });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (!(await this.db.getRepository(Agent).existsBy({ id: data.agentId })))
      throw new BadRequestException('Agent does not exist');
    this.events.publish(location, 'typing', {
      conversationId: data.conversationId,
      agentId: data.agentId,
      typing: data.typing,
    });
    return { accepted: true };
  }

  async presence(locationName: string) {
    const location = await this.resolveLocationId(locationName);
    return { agentIds: this.events.onlineAgents(location) };
  }

  async send(conversationId: number, data: SendMessageDto) {
    const { channel, body } = data;
    return this.db.ormTransaction(async (manager) => {
      const conversations = manager.getRepository(ConversationEntity);
      const found = await conversations.findOneBy({ id: conversationId });
      if (!found) throw new NotFoundException('Conversation not found');
      const location = found.locationId;
      await lockLocation(manager, location);
      const conversation = await conversations.findOne({
        where: { id: conversationId, locationId: location },
        lock: { mode: 'pessimistic_write' },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');

      const messages = manager.getRepository(Message);
      const previous = await messages.findOne({
        where: { locationId: location, conversationId, direction: 'inbound' },
        order: { sentAt: 'DESC', id: 'DESC' },
      });
      if (!previous)
        throw new BadRequestException(
          'Conversation has no message to reply to',
        );

      // Reply to the latest inbound sender, independently of participant ID order.
      const identities = manager.getRepository(ContactIdentity);
      const previousKind = this.channels.get(previous.channel).kind;
      const senderContact = await identities.findOneByOrFail({
        locationId: location,
        kind: previousKind,
        value: previous.to,
      });
      const recipientContact = await identities.findOneByOrFail({
        locationId: location,
        kind: previousKind,
        value: previous.from,
      });
      const kind = this.channels.get(channel).kind;
      const sender =
        kind === previousKind
          ? senderContact
          : await identities.findOne({
              where: {
                locationId: location,
                contactId: senderContact.contactId,
                kind,
              },
              order: { value: 'ASC' },
            });
      const recipient =
        kind === previousKind
          ? recipientContact
          : await identities.findOne({
              where: {
                locationId: location,
                contactId: recipientContact.contactId,
                kind,
              },
              order: { value: 'ASC' },
            });
      if (!sender || !recipient) {
        throw new BadRequestException(
          `Both participants need a ${kind} identity for ${channel}`,
        );
      }

      const message = await messages.save(
        messages.create({
          locationId: location,
          conversationId,
          providerMessageId: this.channels.allocateId(),
          channel,
          direction: 'outbound',
          from: sender.value,
          to: recipient.value,
          body,
          status: 'queued',
          sentAt: new Date(),
        }),
      );
      await manager.getRepository(SendJob).insert({
        messageId: message.id,
        nextAttemptAt: new Date(),
      });
      updateLastMessage(conversation, message);
      await conversations.save(conversation);
      const result = messageView(message);
      await event(manager, location, 'message.new', {
        message: result,
        conversation: conversationView(conversation),
      });
      return result;
    });
  }

  async read(id: number) {
    return this.db.ormTransaction(async (manager) => {
      const conversations = manager.getRepository(ConversationEntity);
      const found = await conversations.findOneBy({ id });
      if (!found) throw new NotFoundException('Conversation not found');
      const location = found.locationId;
      await lockLocation(manager, location);
      const conversation = await conversations.findOne({
        where: { id, locationId: location },
        lock: { mode: 'pessimistic_write' },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      conversation.unreadCount = 0;
      await conversations.save(conversation);
      const result = conversationView(conversation);
      await event(manager, location, 'conversation.updated', result);
      return result;
    });
  }

  async patch(id: number, data: UpdateConversationDto) {
    return this.db.ormTransaction(async (manager) => {
      const conversations = manager.getRepository(ConversationEntity);
      const found = await conversations.findOneBy({ id });
      if (!found) throw new NotFoundException('Conversation not found');
      const location = found.locationId;
      await lockLocation(manager, location);
      const conversation = await conversations.findOne({
        where: { id, locationId: location },
        lock: { mode: 'pessimistic_write' },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      if (
        typeof data.assignedTo === 'number' &&
        !(await manager.getRepository(Agent).existsBy({ id: data.assignedTo }))
      )
        throw new BadRequestException('Agent does not exist');
      if (typeof data.assignedTo === 'number') {
        await markAgentAssigned(manager, data.assignedTo);
      }
      if (data.status !== undefined) conversation.status = data.status;
      if (data.assignedTo !== undefined)
        conversation.assignedTo = data.assignedTo;
      await conversations.save(conversation);
      const result = conversationView(conversation);
      await event(manager, location, 'conversation.updated', result);
      return result;
    });
  }

  async listConversations(locationName: string, query: ConversationQueryDto) {
    const location = await this.resolveLocationId(locationName);
    return this.db.ormTransaction(async (manager) => {
      const conversations = manager
        .getRepository(ConversationEntity)
        .createQueryBuilder('conversation')
        .where('conversation.locationId = :locationId', {
          locationId: location,
        });
      if (query.status)
        conversations.andWhere('conversation.status = :status', {
          status: query.status,
        });
      if (query.assignedTo !== undefined)
        conversations.andWhere('conversation.assignedTo = :assignedTo', {
          assignedTo: query.assignedTo,
        });
      conversations
        .orderBy('conversation.lastMessageAt', 'DESC', 'NULLS LAST')
        .addOrderBy('conversation.id', 'DESC');

      return this.snapshot(
        manager,
        location,
        JSON.stringify([
          'conversations',
          query.status ?? null,
          query.assignedTo ?? null,
        ]),
        query,
        async () => {
          const rows = await conversations.getMany();
          const identities = await manager
            .getRepository(ContactIdentity)
            .findBy({ locationId: location });
          const latestInboundMessages = await manager
            .getRepository(Message)
            .createQueryBuilder('message')
            .distinctOn(['message.conversationId'])
            .select([
              'message.conversationId',
              'message.channel',
              'message.from',
              'message.sentAt',
              'message.id',
            ])
            .where('message.locationId = :locationId', {
              locationId: location,
            })
            .andWhere('message.direction = :direction', {
              direction: 'inbound',
            })
            .orderBy('message.conversationId', 'ASC')
            .addOrderBy('message.sentAt', 'DESC')
            .addOrderBy('message.id', 'DESC')
            .getMany();
          const lastMessageIds = rows.flatMap((conversation) =>
            conversation.lastMessageId === null
              ? []
              : [conversation.lastMessageId],
          );
          const lastMessages = lastMessageIds.length
            ? await manager.getRepository(Message).find({
                where: { id: In(lastMessageIds) },
                select: { id: true, channel: true },
              })
            : [];
          const lastMessageChannels = new Map(
            lastMessages.map((message) => [message.id, message.channel]),
          );
          const customerContactByConversation = new Map<number, number>();
          const identityByKindAndValue = new Map(
            identities.map((identity) => [
              JSON.stringify([identity.kind, identity.value]),
              identity.contactId,
            ]),
          );
          for (const message of latestInboundMessages) {
            const kind =
              this.channels.get(message.channel).kind === 'email'
                ? 'email'
                : 'phone';
            const customer = identityByKindAndValue.get(
              JSON.stringify([kind, message.from]),
            );
            if (customer !== undefined)
              customerContactByConversation.set(
                message.conversationId,
                customer,
              );
          }
          return rows.map((conversation) => {
            const contactId =
              customerContactByConversation.get(conversation.id) ??
              conversation.participantAId;
            return {
              conversationId: conversation.id,
              contactId,
              lastMessageChannel:
                conversation.lastMessageId === null
                  ? null
                  : (lastMessageChannels.get(conversation.lastMessageId) ??
                    null),
              lastMessagePreview: conversation.lastMessagePreview,
              lastMessageAt: conversation.lastMessageAt,
              status: conversation.status,
              assignedTo: conversation.assignedTo,
              unreadCount: conversation.unreadCount,
            };
          });
        },
      );
    }, 'REPEATABLE READ');
  }
  async listMessages(id: number, query: PaginationDto) {
    return this.db.ormTransaction(async (manager) => {
      const conversation = await manager
        .getRepository(ConversationEntity)
        .findOne({
          where: { id },
          select: { locationId: true },
        });
      if (!conversation) throw new NotFoundException('Conversation not found');
      const messages = manager
        .getRepository(Message)
        .createQueryBuilder('message')
        .select([
          'message.id',
          'message.conversationId',
          'message.providerMessageId',
          'message.channel',
          'message.direction',
          'message.from',
          'message.to',
          'message.body',
          'message.status',
          'message.sentAt',
          'message.createdAt',
        ])
        .where('message.locationId = :locationId', {
          locationId: conversation.locationId,
        })
        .andWhere('message.conversationId = :conversationId', {
          conversationId: id,
        })
        .orderBy('message.sentAt', 'ASC')
        .addOrderBy('message.id', 'ASC');
      return this.snapshot(
        manager,
        conversation.locationId,
        JSON.stringify(['messages', id]),
        query,
        async () => messages.getMany().then((rows) => rows.map(messageView)),
      );
    }, 'REPEATABLE READ');
  }

  async search(locationName: string, query: SearchMessagesDto) {
    const location = await this.resolveLocationId(locationName);
    const q = query.q.trim();
    return this.db.ormTransaction((manager) => {
      const messages = manager
        .getRepository(Message)
        .createQueryBuilder('message')
        .select([
          'message.id',
          'message.conversationId',
          'message.providerMessageId',
          'message.channel',
          'message.direction',
          'message.from',
          'message.to',
          'message.body',
          'message.status',
          'message.sentAt',
          'message.createdAt',
        ])
        .where('message.locationId = :locationId', { locationId: location })
        .andWhere(
          "to_tsvector('simple', message.body) @@ websearch_to_tsquery('simple', :query)",
          { query: q },
        )
        .orderBy('message.sentAt', 'DESC')
        .addOrderBy('message.id', 'DESC');
      return this.snapshot(
        manager,
        location,
        JSON.stringify(['search', q]),
        query,
        async () => messages.getMany().then((rows) => rows.map(messageView)),
      );
    }, 'REPEATABLE READ');
  }

  private async snapshot(
    manager: EntityManager,
    location: number,
    scope: string,
    query: PaginationDto,
    loadItems: () => Promise<Record<string, unknown>[]>,
  ) {
    const limit = query.limit;
    let id: number;
    let offset = 0;
    if (query.cursor !== undefined) {
      const [snapshotId, position] = query.cursor.split(':');
      id = Number(snapshotId);
      offset = Number(position);
    } else {
      const items = await loadItems();
      const snapshot = await manager.getRepository(PaginationSnapshot).save(
        manager.getRepository(PaginationSnapshot).create({
          locationId: location,
          scope,
          items,
        }),
      );
      id = snapshot.id;
    }
    const snapshot = await manager
      .getRepository(PaginationSnapshot)
      .createQueryBuilder('snapshot')
      .where('snapshot.id = :id', { id })
      .andWhere('snapshot.locationId = :locationId', { locationId: location })
      .andWhere('snapshot.scope = :scope', { scope })
      .andWhere('snapshot.expiresAt > clock_timestamp()')
      .getOne();
    if (!snapshot)
      throw new GoneException(
        'Cursor expired or does not belong to this query',
      );
    if (offset > snapshot.items.length)
      throw new BadRequestException('Invalid cursor offset');
    const items = snapshot.items.slice(offset, offset + limit);
    return {
      items,
      nextCursor:
        offset + limit < snapshot.items.length
          ? `${id}:${offset + limit}`
          : null,
      hasMore: offset + limit < snapshot.items.length,
    };
  }
}
