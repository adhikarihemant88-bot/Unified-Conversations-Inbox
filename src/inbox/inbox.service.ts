import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { In, type EntityManager } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { ContactIdentity } from '../entities/contact-identity.entity';
import { Conversation as ConversationEntity } from '../entities/conversation.entity';
import { Location } from '../entities/location.entity';
import { Message } from '../entities/message.entity';
import { SendJob } from '../entities/send-job.entity';
import { DatabaseService } from '../utils/database.service';
import { Channels } from './channels';
import { decodeCursor, encodeCursor, type CursorPosition } from './cursor';
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

  async assertAgentAtLocation(locationId: number, agentId: number) {
    if (
      !(await this.db
        .getRepository(Agent)
        .existsBy({ id: agentId, locationId }))
    )
      throw new BadRequestException('Agent does not exist at this location');
  }

  async typing(locationName: string, data: TypingDto) {
    const location = await this.resolveLocationId(locationName);
    const conversation = await this.db
      .getRepository(ConversationEntity)
      .findOneBy({ id: data.conversationId, locationId: location });
    if (!conversation) throw new NotFoundException('Conversation not found');
    await this.assertAgentAtLocation(location, data.agentId);
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
        !(await manager
          .getRepository(Agent)
          .existsBy({ id: data.assignedTo, locationId: location }))
      )
        throw new BadRequestException('Agent does not exist at this location');
      if (typeof data.assignedTo === 'number') {
        await markAgentAssigned(manager, location, data.assignedTo);
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
    const position = this.cursorPosition(query.cursor);
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
      // Rows strictly after the cursor in (lastMessageAt DESC NULLS LAST, id DESC).
      if (position?.at)
        conversations.andWhere(
          '(conversation.lastMessageAt < :at OR (conversation.lastMessageAt = :at AND conversation.id < :cursorId) OR conversation.lastMessageAt IS NULL)',
          { at: position.at, cursorId: position.id },
        );
      else if (position)
        conversations.andWhere(
          'conversation.lastMessageAt IS NULL AND conversation.id < :cursorId',
          { cursorId: position.id },
        );
      const rows = await conversations
        .orderBy('conversation.lastMessageAt', 'DESC', 'NULLS LAST')
        .addOrderBy('conversation.id', 'DESC')
        .limit(query.limit + 1)
        .getMany();
      const page = this.paginate(rows, query.limit, (conversation) =>
        encodeCursor(conversation.lastMessageAt, conversation.id),
      );
      return {
        items: await this.conversationSummaries(manager, location, page.items),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    }, 'REPEATABLE READ');
  }

  async listMessages(id: number, query: PaginationDto) {
    const position = this.cursorPosition(query.cursor, true);
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
        .select(messageColumnsToSelect)
        .where('message.locationId = :locationId', {
          locationId: conversation.locationId,
        })
        .andWhere('message.conversationId = :conversationId', {
          conversationId: id,
        });
      // Chronological: rows strictly after the cursor in (sentAt ASC, id ASC).
      if (position)
        messages.andWhere(
          '(message.sentAt > :at OR (message.sentAt = :at AND message.id > :cursorId))',
          { at: position.at, cursorId: position.id },
        );
      const rows = await messages
        .orderBy('message.sentAt', 'ASC')
        .addOrderBy('message.id', 'ASC')
        .limit(query.limit + 1)
        .getMany();
      const page = this.paginate(rows, query.limit, (message) =>
        encodeCursor(message.sentAt, message.id),
      );
      return {
        items: page.items.map(messageView),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  async search(locationName: string, query: SearchMessagesDto) {
    const location = await this.resolveLocationId(locationName);
    const q = query.q.trim();
    const position = this.cursorPosition(query.cursor, true);
    return this.db.ormTransaction(async (manager) => {
      const messages = manager
        .getRepository(Message)
        .createQueryBuilder('message')
        .select(messageColumnsToSelect)
        .where('message.locationId = :locationId', { locationId: location })
        .andWhere(
          "to_tsvector('simple', message.body) @@ websearch_to_tsquery('simple', :query)",
          { query: q },
        );
      // Newest first: rows strictly after the cursor in (sentAt DESC, id DESC).
      if (position)
        messages.andWhere(
          '(message.sentAt < :at OR (message.sentAt = :at AND message.id < :cursorId))',
          { at: position.at, cursorId: position.id },
        );
      const rows = await messages
        .orderBy('message.sentAt', 'DESC')
        .addOrderBy('message.id', 'DESC')
        .limit(query.limit + 1)
        .getMany();
      const page = this.paginate(rows, query.limit, (message) =>
        encodeCursor(message.sentAt, message.id),
      );
      return {
        items: page.items.map(messageView),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  /** Decodes the optional cursor; `requireTime` rejects the null-time form. */
  private cursorPosition(
    cursor: string | undefined,
    requireTime = false,
  ): CursorPosition | undefined {
    if (cursor === undefined) return undefined;
    const position = decodeCursor(cursor);
    if (!position || (requireTime && position.at === null))
      throw new BadRequestException('Invalid cursor');
    return position;
  }

  /** `rows` holds up to limit + 1 rows; the extra one only proves there is more. */
  private paginate<T>(
    rows: T[],
    limit: number,
    cursorOf: (row: T) => string,
  ): { items: T[]; nextCursor: string | null; hasMore: boolean } {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? cursorOf(items[items.length - 1]) : null,
      hasMore,
    };
  }

  /** Adds the latest channel and customer contact for one page of conversations. */
  private async conversationSummaries(
    manager: EntityManager,
    location: number,
    rows: ConversationEntity[],
  ) {
    if (rows.length === 0) return [];
    const lastMessageIds = rows.flatMap((conversation) =>
      conversation.lastMessageId === null ? [] : [conversation.lastMessageId],
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
      .where('message.locationId = :locationId', { locationId: location })
      .andWhere('message.conversationId IN (:...conversationIds)', {
        conversationIds: rows.map((conversation) => conversation.id),
      })
      .andWhere('message.direction = :direction', { direction: 'inbound' })
      .orderBy('message.conversationId', 'ASC')
      .addOrderBy('message.sentAt', 'DESC')
      .addOrderBy('message.id', 'DESC')
      .getMany();
    const identityKeys = latestInboundMessages.map((message) => ({
      locationId: location,
      kind: this.channels.get(message.channel).kind,
      value: message.from,
    }));
    const identities = identityKeys.length
      ? await manager
          .getRepository(ContactIdentity)
          .find({ where: identityKeys })
      : [];
    const identityByKindAndValue = new Map(
      identities.map((identity) => [
        JSON.stringify([identity.kind, identity.value]),
        identity.contactId,
      ]),
    );
    const customerContactByConversation = new Map<number, number>();
    for (const message of latestInboundMessages) {
      const customer = identityByKindAndValue.get(
        JSON.stringify([this.channels.get(message.channel).kind, message.from]),
      );
      if (customer !== undefined)
        customerContactByConversation.set(message.conversationId, customer);
    }
    return rows.map((conversation) => ({
      conversationId: conversation.id,
      contactId:
        customerContactByConversation.get(conversation.id) ??
        conversation.participantAId,
      lastMessageChannel:
        conversation.lastMessageId === null
          ? null
          : (lastMessageChannels.get(conversation.lastMessageId) ?? null),
      lastMessagePreview: conversation.lastMessagePreview,
      lastMessageAt: conversation.lastMessageAt,
      status: conversation.status,
      assignedTo: conversation.assignedTo,
      unreadCount: conversation.unreadCount,
    }));
  }
}

const messageColumnsToSelect = [
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
];
