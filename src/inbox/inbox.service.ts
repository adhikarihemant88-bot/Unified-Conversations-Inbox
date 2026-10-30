import {
  BadRequestException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../utils/database.service';
import { Channels } from './channels';
import type { SendMessageDto } from './dto/send-message.dto';
import type { UpdateConversationDto } from './dto/update-conversation.dto';
import type {
  ConversationQueryDto,
  PaginationDto,
  SearchMessagesDto,
} from './dto/pagination.dto';
import { conversationSelect, event, messageSelect } from './storage';

interface Conversation {
  id: string;
  location_id: string;
  contact_id: string;
}
@Injectable()
export class InboxService {
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: Channels,
  ) {}

  async send(location: string, conversationId: string, data: SendMessageDto) {
    const { channel: medium, body } = data;
    return this.db.transaction(async (c) => {
      const conversation = await this.conversation(
        c,
        location,
        conversationId,
        true,
      );
      const kind = this.channels.get(medium).kind;
      const identity = (
        await c.query<{ value: string }>(
          'SELECT value FROM contact_identities WHERE location_id=$1 AND contact_id=$2 AND kind=$3 ORDER BY value LIMIT 1',
          [location, conversation.contact_id, kind],
        )
      ).rows[0];
      if (!identity)
        throw new BadRequestException(
          `Contact has no ${kind} identity for ${medium}`,
        );
      const previous = (
        await c.query<{ recipient: string }>(
          "SELECT recipient FROM messages WHERE conversation_id=$1 AND location_id=$2 AND channel=$3 AND direction='inbound' ORDER BY sent_at DESC,id DESC LIMIT 1",
          [conversationId, location, medium],
        )
      ).rows[0];
      const sender =
        previous?.recipient ??
        (medium === 'email' ? 'inbox@example.com' : '+918000000000');
      const id = randomUUID();
      const sentAt = new Date().toISOString();
      await c.query(
        `INSERT INTO messages(id,location_id,conversation_id,provider_message_id,channel,direction,sender,recipient,body,status,sent_at)
        VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,'queued',$9)`,
        [
          id,
          location,
          conversationId,
          this.channels.allocateId(),
          medium,
          sender,
          identity.value,
          body,
          sentAt,
        ],
      );
      await c.query('INSERT INTO send_jobs(message_id) VALUES ($1)', [id]);
      await this.updateLatest(c, conversationId, id, sentAt, body, false);
      const message = (await c.query(`${messageSelect} WHERE id=$1`, [id]))
        .rows[0];
      await event(c, location, 'message.new', {
        message,
        conversation: (
          await c.query(`${conversationSelect} WHERE id=$1`, [conversationId])
        ).rows[0],
      });
      return message;
    });
  }

  private async updateLatest(
    c: PoolClient,
    conversationId: string,
    messageId: string,
    sentAt: string,
    body: string,
    inbound: boolean,
  ) {
    await c.query(
      `UPDATE conversations SET unread_count=unread_count+$5,
      status=CASE WHEN $5=1 THEN 'open' ELSE status END,
      last_message_preview=CASE WHEN last_message_at IS NULL OR (last_message_at,last_message_id)<($3::timestamptz,$2::uuid) THEN $4 ELSE last_message_preview END,
      last_message_id=CASE WHEN last_message_at IS NULL OR (last_message_at,last_message_id)<($3::timestamptz,$2::uuid) THEN $2::uuid ELSE last_message_id END,
      last_message_at=GREATEST(last_message_at,$3::timestamptz) WHERE id=$1`,
      [conversationId, messageId, sentAt, body.slice(0, 160), inbound ? 1 : 0],
    );
  }

  private async conversation(
    c: PoolClient,
    location: string,
    id: string,
    lock = false,
  ): Promise<Conversation> {
    const row = (
      await c.query<Conversation>(
        `SELECT id,location_id,contact_id FROM conversations WHERE location_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
        [location, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }

  async read(location: string, id: string) {
    return this.db.transaction(async (c) => {
      await this.conversation(c, location, id, true);
      await c.query('UPDATE conversations SET unread_count=0 WHERE id=$1', [
        id,
      ]);
      const row = (await c.query(`${conversationSelect} WHERE id=$1`, [id]))
        .rows[0];
      await event(c, location, 'conversation.updated', row);
      return row;
    });
  }

  async patch(location: string, id: string, data: UpdateConversationDto) {
    return this.db.transaction(async (c) => {
      await this.conversation(c, location, id, true);
      if (
        typeof data.assignedTo === 'string' &&
        !(
          await c.query('SELECT 1 FROM agents WHERE location_id=$1 AND id=$2', [
            location,
            data.assignedTo,
          ])
        ).rowCount
      )
        throw new BadRequestException('Agent does not belong to this location');
      await c.query(
        'UPDATE conversations SET status=COALESCE($2,status),assigned_to=CASE WHEN $3 THEN $4 ELSE assigned_to END WHERE id=$1',
        [
          id,
          data.status ?? null,
          data.assignedTo !== undefined,
          data.assignedTo ?? null,
        ],
      );
      const row = (await c.query(`${conversationSelect} WHERE id=$1`, [id]))
        .rows[0];
      await event(c, location, 'conversation.updated', row);
      return row;
    });
  }

  async listConversations(location: string, query: ConversationQueryDto) {
    const status = query.status ?? null;
    const assigned = query.assignedTo ?? null;
    return this.snapshot(
      location,
      JSON.stringify(['conversations', status, assigned]),
      query,
      `${conversationSelect} WHERE location_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR assigned_to=$3) ORDER BY last_message_at DESC NULLS LAST,id DESC`,
      [location, status, assigned],
    );
  }
  async listMessages(location: string, id: string, query: PaginationDto) {
    await this.db.transaction((c) => this.conversation(c, location, id));
    return this.snapshot(
      location,
      JSON.stringify(['messages', id]),
      query,
      `${messageSelect} WHERE location_id=$1 AND conversation_id=$2 ORDER BY sent_at,id`,
      [location, id],
    );
  }

  async search(location: string, query: SearchMessagesDto) {
    const q = query.q.trim();
    return this.snapshot(
      location,
      JSON.stringify(['search', q]),
      query,
      `${messageSelect} WHERE location_id=$1 AND to_tsvector('simple',body) @@ websearch_to_tsquery('simple',$2) ORDER BY sent_at DESC,id DESC`,
      [location, q],
    );
  }

  private async snapshot(
    location: string,
    scope: string,
    query: PaginationDto,
    sql: string,
    params: unknown[],
  ) {
    const limit = query.limit;
    let id: string;
    let offset = 0;
    if (query.cursor !== undefined) {
      const [snapshotId, position] = query.cursor.split(':');
      id = snapshotId;
      offset = Number(position);
    } else {
      id = randomUUID();
      // One SQL statement gives a consistent view of rows and their ordering.
      await this.db.query(
        `INSERT INTO pagination_snapshots(id,location_id,scope,items)
        SELECT $${params.length + 1},$1,$${params.length + 2},COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (${sql}) t`,
        [...params, id, scope],
      );
    }
    const [snapshot] = await this.db.query<{ total: number; items: unknown[] }>(
      `SELECT jsonb_array_length(items) AS total,
      COALESCE((SELECT jsonb_agg(value ORDER BY ordinality) FROM jsonb_array_elements(items) WITH ORDINALITY WHERE ordinality>$4 AND ordinality<=$5), '[]'::jsonb) AS items
      FROM pagination_snapshots WHERE id=$1 AND location_id=$2 AND scope=$3 AND expires_at>clock_timestamp()`,
      [id, location, scope, offset, offset + limit],
    );
    if (!snapshot)
      throw new GoneException(
        'Cursor expired or does not belong to this query',
      );
    if (offset > snapshot.total)
      throw new BadRequestException('Invalid cursor offset');
    return {
      items: snapshot.items,
      nextCursor:
        offset + limit < snapshot.total ? `${id}:${offset + limit}` : null,
    };
  }
}
