import { ConflictException, Injectable } from '@nestjs/common';
import { Location } from '../entities/location.entity';
import { Message } from '../entities/message.entity';
import { DatabaseService } from '../utils/database.service';
import { Channels } from '../inbox/channels';
import { advance, timestamp } from '../inbox/domain';
import {
  conversationView,
  event,
  lockLocation,
  messageView,
} from '../inbox/storage';
import type { InboundWebhookDto } from './dto/inbound-webhook.dto';
import type { StatusWebhookDto } from './dto/status-webhook.dto';
import {
  applyStatus,
  findOrCreateContact,
  findOrCreateConversation,
  providerLock,
  updateConversationForInbound,
} from './webhook.storage';

@Injectable()
export class WebhookService {
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: Channels,
  ) {}

  async inbound(data: InboundWebhookDto) {
    const { providerMessageId, locationId: locationName, channel, body } = data;
    const adapter = this.channels.get(channel);
    const from = adapter.normalize(data.from);
    const to = adapter.normalize(data.to);
    const sentAt = new Date(timestamp(data.sentAt, 'sentAt'));

    return this.db.ormTransaction(async (manager) => {
      const provider = await providerLock(manager, providerMessageId, sentAt);
      const messages = manager.getRepository(Message);
      const locations = manager.getRepository(Location);
      const existing = await messages.findOneBy({ providerMessageId });
      if (existing) {
        // A provider retry replays the same payload: acknowledge it without
        // writing anything. A reused ID with different content is a conflict.
        const existingLocation = await locations.findOneBy({
          id: existing.locationId,
        });
        if (
          existingLocation?.name !== locationName ||
          existing.channel !== channel ||
          existing.from !== from ||
          existing.to !== to ||
          existing.body !== body ||
          existing.sentAt.getTime() !== sentAt.getTime()
        )
          throw new ConflictException('Duplicate providerMessageId');
        return { duplicate: true, message: messageView(existing) };
      }
      let location = await locations.findOneBy({ name: locationName });
      if (!location) {
        //if location is not found adding it to the database
        await locations
          .createQueryBuilder()
          .insert()
          .values({ name: locationName })
          .orIgnore()
          .execute();
        location = await locations.findOneByOrFail({ name: locationName });
      }
      const locationId = location.id;
      await lockLocation(manager, locationId);
      //added location
      // {
      //     "providerMessageId": "SM_abc123",
      //     "locationId": "loc_1",
      //     "channel": "sms",
      //     "from": "+91 98765 43210",
      //     "to": "+91 80000 00000",
      //     "body": "Is the offer still valid?",
      //     "sentAt": "2026-10-28T10:15:00Z"
      // }
      // Resolve identities in a stable order for simultaneous A->B and B->A.
      const [firstAddress, secondAddress] = [from, to].sort();
      const firstContactId = await findOrCreateContact(
        manager,
        locationId,
        adapter.kind,
        firstAddress,
      );
      const secondContactId = await findOrCreateContact(
        manager,
        locationId,
        adapter.kind,
        secondAddress,
      );
      const conversation = await findOrCreateConversation(
        manager,
        locationId,
        firstContactId,
        secondContactId,
      );
      const message = await messages.save(
        messages.create({
          locationId,
          conversationId: conversation.id,
          providerMessageId,
          channel,
          direction: 'inbound',
          from,
          to,
          body,
          status: advance('delivered', provider.status),
          sentAt,
        }),
      );
      await updateConversationForInbound(
        manager,
        conversation,
        sentAt,
        message.id,
        body,
      );
      const result = messageView(message);
      await event(manager, locationId, 'message.new', {
        message: result,
        conversation: conversationView(conversation),
      });
      return { duplicate: false, message: result };
    });
  }

  async status(data: StatusWebhookDto) {
    const time = new Date(timestamp(data.timestamp, 'timestamp'));
    await this.db.ormTransaction(async (manager) => {
      await providerLock(manager, data.providerMessageId, time);
      await applyStatus(manager, data.providerMessageId, data.status, time);
    });
    return { accepted: true };
  }
}
