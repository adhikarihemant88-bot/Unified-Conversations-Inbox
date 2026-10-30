import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../utils/database.service';
import { Channels } from '../inbox/channels';
import { advance, timestamp, type DeliveryStatus } from '../inbox/domain';
import type { InboundWebhookDto } from './dto/inbound-webhook.dto';
import type { StatusWebhookDto } from './dto/status-webhook.dto';
import { conversationColumns, event, messageColumns } from '../inbox/storage';
import { applyStatus, providerLock } from './webhook.storage';

@Injectable()
export class WebhookService {
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: Channels,
  ) {}

  async inbound(data: InboundWebhookDto) {
    const {
      providerMessageId: providerId,
      locationId: location,
      channel: medium,
      body,
    } = data;

    const adapter = this.channels.get(medium);
    const sender = adapter.normalize(data.from);
    const recipient = adapter.normalize(data.to);
    const sentAt = timestamp(data.sentAt, 'sentAt');
    const id = randomUUID();
    return this.db.transaction(async (c) => {
      // Acquire this lock in its own statement: the next statement must get a
      // fresh READ COMMITTED snapshot after any competing ingestion commits.
      await providerLock(c, providerId);
      const {
        rows: [context],
      } = await c.query<{
        duplicate: boolean;
        location_exists: boolean;
        contact_id: string | null;
        pending_status: DeliveryStatus | null;
      }>(
        `SELECT EXISTS(SELECT 1 FROM messages WHERE provider_message_id=$1) AS duplicate,
          EXISTS(SELECT 1 FROM locations WHERE id=$2) AS location_exists,
          (SELECT contact_id FROM contact_identities WHERE location_id=$2 AND kind=$3 AND value=$4) AS contact_id,
          (SELECT status FROM provider_states WHERE provider_message_id=$1) AS pending_status`,
        [providerId, location, adapter.kind, sender],
      );
      if (context.duplicate) {
        throw new ConflictException('Duplicate providerMessageId');
      }
      if (!context.location_exists)
        throw new NotFoundException('Location not found');
      let contactId = context.contact_id;
      if (!contactId) {
        // Existing identities need no creation lock. On a miss, lock and check
        // again in a new statement so concurrent first messages share a contact.
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('identity:' || $1, 0))",
          [JSON.stringify([location, adapter.kind, sender])],
        );
        const {
          rows: [identity],
        } = await c.query<{ contact_id: string }>(
          `WITH existing AS MATERIALIZED (
            SELECT contact_id FROM contact_identities WHERE location_id=$1 AND kind=$2 AND value=$3
          ), new_contact AS (
            INSERT INTO contacts(id,location_id)
            SELECT $4::uuid,$1 WHERE NOT EXISTS(SELECT 1 FROM existing)
            RETURNING id
          ), new_identity AS (
            INSERT INTO contact_identities(location_id,contact_id,kind,value)
            SELECT $1,id,$2,$3 FROM new_contact RETURNING contact_id
          )
          SELECT contact_id FROM existing UNION ALL SELECT contact_id FROM new_identity`,
          [location, adapter.kind, sender, randomUUID()],
        );
        contactId = identity.contact_id;
      }
      // This upsert both locks the conversation and performs its one required
      // update, including serialization with mark-as-read and open/close.
      const {
        rows: [conversation],
      } = await c.query<{ id: string }>(
        `INSERT INTO conversations AS current(id,location_id,contact_id,unread_count,last_message_at,last_message_id,last_message_preview)
        VALUES ($1,$2,$3,1,$4,$5,$6)
        ON CONFLICT(location_id,contact_id) DO UPDATE SET
          unread_count=current.unread_count+1, status='open',
          last_message_preview=CASE WHEN current.last_message_at IS NULL OR (current.last_message_at,current.last_message_id)<(EXCLUDED.last_message_at,EXCLUDED.last_message_id)
            THEN EXCLUDED.last_message_preview ELSE current.last_message_preview END,
          last_message_id=CASE WHEN current.last_message_at IS NULL OR (current.last_message_at,current.last_message_id)<(EXCLUDED.last_message_at,EXCLUDED.last_message_id)
            THEN EXCLUDED.last_message_id ELSE current.last_message_id END,
          last_message_at=GREATEST(current.last_message_at,EXCLUDED.last_message_at)
        RETURNING ${conversationColumns}`,
        [randomUUID(), location, contactId, sentAt, id, body.slice(0, 160)],
      );
      const {
        rows: [message],
      } = await c.query(
        `INSERT INTO messages(id,location_id,conversation_id,provider_message_id,channel,direction,sender,recipient,body,status,sent_at)
        VALUES ($1,$2,$3,$4,$5,'inbound',$6,$7,$8,$9,$10)
        RETURNING ${messageColumns}`,
        [
          id,
          location,
          conversation.id,
          providerId,
          medium,
          sender,
          recipient,
          body,
          context.pending_status
            ? advance('delivered', context.pending_status)
            : 'delivered',
          sentAt,
        ],
      );
      await event(c, location, 'message.new', { message, conversation });
      return { duplicate: false, message };
    });
  }

  async status(data: StatusWebhookDto) {
    const { providerMessageId: id, status } = data;
    const time = timestamp(data.timestamp, 'timestamp');
    await this.db.transaction(async (c) => {
      await providerLock(c, id);
      await applyStatus(c, id, status, time);
    });
    return { accepted: true };
  }
}
