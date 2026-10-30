import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/utils/database.service';
import { Channels } from '../src/inbox/channels';
import { SendWorker } from '../src/inbox/send.worker';

describe('Inbox (real PostgreSQL)', () => {
  let app: INestApplication;
  let admin: Pool;
  let db: DatabaseService;
  let channels: Channels;
  let worker: SendWorker;
  let base: string;
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const auth = { Authorization: 'Bearer agent-one' };
  const auth2 = { Authorization: 'Bearer agent-two' };
  const webhook = { 'x-webhook-token': 'test-webhook' };
  const payload = (id = randomUUID(), extra: Record<string, unknown> = {}) => ({
    providerMessageId: id,
    locationId: 'loc_1',
    channel: 'sms',
    from: '+91 98765 43210',
    to: '+91 80000 00000',
    body: 'Hello',
    sentAt: '2026-10-28T10:15:00Z',
    ...extra,
  });
  const inbound = (body = payload(), expectedStatus = 200) =>
    request(app.getHttpServer())
      .post('/webhooks/inbound')
      .set(webhook)
      .send(body)
      .expect(expectedStatus);
  const callback = (id: string, status: string) =>
    request(app.getHttpServer())
      .post('/webhooks/status')
      .set(webhook)
      .send({
        providerMessageId: id,
        status,
        timestamp: '2026-10-28T10:16:00Z',
      })
      .expect(200);
  const list = (query = '') =>
    request(app.getHttpServer())
      .get(`/locations/loc_1/conversations${query}`)
      .set(auth)
      .expect(200);
  const history = (id: string, query = '') =>
    request(app.getHttpServer())
      .get(`/conversations/${id}/messages${query}`)
      .set(auth)
      .expect(200);
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Run npm run test:e2e for a disposable PostgreSQL server',
      );
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const c = await admin.connect();
    try {
      await c.query(`SET search_path TO ${schema}`);
      await c.query(readFileSync('db/001_init.sql', 'utf8'));
    } finally {
      c.release();
    }
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.WEBHOOK_TOKEN = 'test-webhook';
    process.env.WORKER_ENABLED = 'false';
    process.env.MOCK_FAILURE_RATE = '0';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    db = app.get(DatabaseService);
    channels = app.get(Channels);
    worker = app.get(SendWorker);
  }, 30000);
  beforeEach(async () => {
    jest.restoreAllMocks();
    await db.query(
      'TRUNCATE pagination_snapshots,inbox_events,send_jobs,provider_states,messages,conversations,contact_identities,contacts,agents,locations CASCADE',
    );
    await db.query(
      "INSERT INTO locations VALUES ('loc_1','One'),('loc_2','Two')",
    );
    for (const [id, location, token] of [
      ['agent_1', 'loc_1', 'agent-one'],
      ['agent_2', 'loc_2', 'agent-two'],
    ]) {
      await db.query('INSERT INTO agents VALUES ($1,$2,$3)', [
        id,
        location,
        createHash('sha256').update(token).digest('hex'),
      ]);
    }
  });
  afterAll(async () => {
    if (app) await app.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('stores 30 parallel duplicate webhooks once with one unread increment/event', async () => {
    const body = payload();
    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        request(app.getHttpServer())
          .post('/webhooks/inbound')
          .set(webhook)
          .send(body),
      ),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(29);
    expect((await list()).body.data.items[0].unreadCount).toBe(1);
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM messages'))[0]
        .count,
    ).toBe('1');
    expect(
      (
        await db.query<{ count: string }>('SELECT count(*) FROM inbox_events')
      )[0].count,
    ).toBe('1');
  });
  it('50 parallel first messages create one contact/conversation and unreadCount=50', async () => {
    await Promise.all(Array.from({ length: 50 }, () => inbound()));
    const rows = (await list()).body.data.items;
    expect(rows).toHaveLength(1);
    expect(rows[0].unreadCount).toBe(50);
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM contacts'))[0]
        .count,
    ).toBe('1');
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM messages'))[0]
        .count,
    ).toBe('50');
    const events = await db.query<{
      payload: { conversation: { unreadCount: number } };
    }>('SELECT payload FROM inbox_events ORDER BY id');
    expect(events.map((e) => e.payload.conversation.unreadCount)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });
  it('unifies normalized SMS/WhatsApp phone identities and explicitly linked email', async () => {
    const first = (await inbound()).body.data.message;
    const contact = (await list()).body.data.items[0].contactId;
    await db.query(
      "INSERT INTO contact_identities VALUES ('loc_1',$1,'email','customer@example.com')",
      [contact],
    );
    await inbound(
      payload(undefined, {
        channel: 'whatsapp',
        from: 'whatsapp:+919876543210',
      }),
    );
    await inbound(
      payload(undefined, {
        channel: 'email',
        from: 'Customer@Example.com',
        to: 'inbox@example.com',
      }),
    );
    expect((await list()).body.data.items).toHaveLength(1);
    expect((await history(first.conversationId)).body.data.items).toHaveLength(
      3,
    );
  });
  it('isolates identical phone numbers in different locations', async () => {
    await inbound();
    await inbound(payload(undefined, { locationId: 'loc_2' }));
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM contacts'))[0]
        .count,
    ).toBe('2');
    expect((await list()).body.data.items).toHaveLength(1);
  });
  it('parallel phone and email messages share the first conversation for a linked contact', async () => {
    const id = randomUUID();
    await db.query("INSERT INTO contacts(id,location_id) VALUES ($1,'loc_1')", [
      id,
    ]);
    await db.query(
      "INSERT INTO contact_identities VALUES ('loc_1',$1,'phone','+919876543210'),('loc_1',$1,'email','customer@example.com')",
      [id],
    );
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        inbound(
          payload(
            undefined,
            i % 2 === 0
              ? {}
              : {
                  channel: 'email',
                  from: 'customer@example.com',
                  to: 'inbox@example.com',
                },
          ),
        ),
      ),
    );
    const rows = (await list()).body.data.items;
    expect(rows).toHaveLength(1);
    expect(rows[0].contactId).toBe(id);
    expect(rows[0].unreadCount).toBe(50);
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM contacts'))[0]
        .count,
    ).toBe('1');
  });
  it('existing contacts do not wait on an identity-creation lock', async () => {
    await inbound();
    let ready!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = db.transaction(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('identity:' || $1, 0))",
        [JSON.stringify(['loc_1', 'phone', '+919876543210'])],
      );
      ready();
      await unlock;
    });
    try {
      await acquired;
      await request(app.getHttpServer())
        .post('/webhooks/inbound')
        .set(webhook)
        .send(payload())
        .timeout({ deadline: 2000 })
        .expect(200);
    } finally {
      release();
      await holding;
    }
    expect((await list()).body.data.items[0].unreadCount).toBe(2);
  });
  it('an unknown location leaves no contact, conversation, message or event', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/inbound')
      .set(webhook)
      .send(payload(undefined, { locationId: 'missing' }))
      .expect(404);
    for (const table of [
      'contacts',
      'conversations',
      'messages',
      'inbox_events',
    ]) {
      expect(
        (await db.query<{ count: string }>(`SELECT count(*) FROM ${table}`))[0]
          .count,
      ).toBe('0');
    }
  });
  it('rejects a reused provider ID with different payload/location', async () => {
    const body = payload();
    await inbound(body);
    await request(app.getHttpServer())
      .post('/webhooks/inbound')
      .set(webhook)
      .send({ ...body, locationId: 'loc_2' })
      .expect(409);
  });
  it('parallel reordered statuses never regress', async () => {
    const m = (await inbound()).body.data.message;
    await Promise.all(
      ['read', 'sent', 'delivered', 'queued'].map((s) =>
        callback(m.providerMessageId, s),
      ),
    );
    expect((await history(m.conversationId)).body.data.items[0].status).toBe(
      'read',
    );
    await callback(m.providerMessageId, 'sent');
    expect((await history(m.conversationId)).body.data.items[0].status).toBe(
      'read',
    );
  });
  it('persists early callbacks and reconciles concurrent callback/message insertion', async () => {
    const early = randomUUID();
    await callback(early, 'read');
    const first = (await inbound(payload(early))).body.data.message;
    expect(first.status).toBe('read');
    const id = randomUUID();
    await Promise.all([callback(id, 'read'), inbound(payload(id))]);
    const rows = (await history(first.conversationId)).body.data.items;
    expect(
      rows.find(
        (m: { providerMessageId: string }) => m.providerMessageId === id,
      ).status,
    ).toBe('read');
  });
  it('treats failed as terminal', async () => {
    const m = (await inbound()).body.data.message;
    await callback(m.providerMessageId, 'failed');
    await callback(m.providerMessageId, 'read');
    expect((await history(m.conversationId)).body.data.items[0].status).toBe(
      'failed',
    );
  });
  it('reopens on new inbound, leaves closed on duplicate, and filters assignment', async () => {
    const body = payload();
    const m = (await inbound(body)).body.data.message;
    await request(app.getHttpServer())
      .patch(`/conversations/${m.conversationId}`)
      .set(auth)
      .send({ status: 'closed', assignedTo: 'agent_1' })
      .expect(200);
    await inbound(body, 409);
    expect((await list()).body.data.items[0].status).toBe('closed');
    await inbound();
    expect((await list()).body.data.items[0].status).toBe('open');
    expect(
      (await list('?status=open&assignedTo=agent_1')).body.data.items,
    ).toHaveLength(1);
  });
  it('late older messages leave the latest preview intact', async () => {
    await inbound(
      payload(undefined, { body: 'Latest', sentAt: '2026-10-29T10:00:00Z' }),
    );
    await inbound(payload(undefined, { body: 'Older' }));
    const c = (await list()).body.data.items[0];
    expect(c.lastMessagePreview).toBe('Latest');
    expect(c.unreadCount).toBe(2);
  });
  it('mark-read races serialize and subsequent messages remain unread', async () => {
    const m = (await inbound()).body.data.message;
    await Promise.all([
      request(app.getHttpServer())
        .post(`/conversations/${m.conversationId}/read`)
        .set(auth)
        .expect(200),
      ...Array.from({ length: 20 }, () => inbound()),
    ]);
    const before = (await list()).body.data.items[0].unreadCount;
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThanOrEqual(20);
    const events = await db.query<{ type: string }>(
      'SELECT type FROM inbox_events ORDER BY id',
    );
    let expected = 0;
    for (const e of events)
      expected = e.type === 'message.new' ? expected + 1 : 0;
    expect(before).toBe(expected);
    await request(app.getHttpServer())
      .post(`/conversations/${m.conversationId}/read`)
      .set(auth)
      .expect(200);
    await Promise.all(Array.from({ length: 10 }, () => inbound()));
    expect((await list()).body.data.items[0].unreadCount).toBe(10);
  });
  it('message snapshot pages handle timestamp ties and late inserts', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++)
      ids.push((await inbound()).body.data.message.id);
    const c = (await list()).body.data.items[0].id;
    let page = (await history(c, '?limit=2')).body.data;
    const seen = [...page.items];
    await inbound(payload(undefined, { sentAt: '2026-10-20T00:00:00Z' }));
    await inbound();
    while (page.nextCursor) {
      page = (await history(c, `?limit=2&cursor=${page.nextCursor}`)).body.data;
      seen.push(...page.items);
    }
    const compare = (a: string, b: string) => a.localeCompare(b);
    expect(seen.map((m) => m.id as string).sort(compare)).toEqual(
      ids.sort(compare),
    );
    expect((await history(c)).body.data.items).toHaveLength(7);
  });
  it('conversation pages include rows that move ahead of the cursor after updates', async () => {
    const a = (
      await inbound(
        payload(undefined, {
          from: '+919000000001',
          sentAt: '2026-10-28T12:00:00Z',
        }),
      )
    ).body.data.message;
    const b = (await inbound(payload(undefined, { from: '+919000000002' })))
      .body.data.message;
    const page = (await list('?limit=1')).body.data;
    expect(page.items[0].id).toBe(a.conversationId);
    await inbound(
      payload(undefined, {
        from: '+919000000002',
        sentAt: '2026-10-29T12:00:00Z',
      }),
    );
    await inbound(payload(undefined, { from: '+919000000003' }));
    const second = (await list(`?limit=1&cursor=${page.nextCursor}`)).body.data;
    expect(second.items.map((c: { id: string }) => c.id)).toEqual([
      b.conversationId,
    ]);
    expect(second.nextCursor).toBeNull();
  });
  it('rejects expired cursors and cursors reused with different filters', async () => {
    await inbound();
    await inbound(payload(undefined, { from: '+919000000001' }));
    const page = (await list('?limit=1')).body.data;
    await request(app.getHttpServer())
      .get(
        `/locations/loc_1/conversations?status=open&cursor=${page.nextCursor}`,
      )
      .set(auth)
      .expect(410);
    await db.query(
      "UPDATE pagination_snapshots SET expires_at=clock_timestamp()-interval '1 second'",
    );
    await request(app.getHttpServer())
      .get(`/locations/loc_1/conversations?cursor=${page.nextCursor}`)
      .set(auth)
      .expect(410);
  });
  it('queues outbound, claims once under parallel workers, and preserves unread', async () => {
    const m = (await inbound()).body.data.message;
    const send = jest.spyOn(channels.get('sms'), 'send').mockResolvedValue();
    const out = (
      await request(app.getHttpServer())
        .post(`/conversations/${m.conversationId}/messages`)
        .set(auth)
        .send({ channel: 'sms', body: 'Reply' })
        .expect(202)
    ).body.data;
    expect(out.status).toBe('queued');
    await Promise.all([
      worker.processOne(),
      worker.processOne(),
      worker.processOne(),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await history(m.conversationId)).body.data.items.find(
        (r: { id: string }) => r.id === out.id,
      ).status,
    ).toBe('sent');
    expect((await list()).body.data.items[0].unreadCount).toBe(1);
  });
  it('backs off and fails after exactly three persisted attempts', async () => {
    const m = (await inbound()).body.data.message;
    const send = jest
      .spyOn(channels.get('sms'), 'send')
      .mockRejectedValue(new Error('provider down'));
    await request(app.getHttpServer())
      .post(`/conversations/${m.conversationId}/messages`)
      .set(auth)
      .send({ channel: 'sms', body: 'Reply' })
      .expect(202);
    await worker.processOne();
    expect(await worker.processOne()).toBe(false);
    expect(
      (
        await db.query<{ attempts: number }>('SELECT attempts FROM send_jobs')
      )[0].attempts,
    ).toBe(1);
    for (let n = 0; n < 2; n++) {
      await db.query('UPDATE send_jobs SET next_attempt_at=clock_timestamp()');
      await worker.processOne();
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(
      (await history(m.conversationId)).body.data.items.find(
        (r: { direction: string }) => r.direction === 'outbound',
      ).status,
    ).toBe('failed');
    expect(await worker.processOne()).toBe(false);
  });
  it('worker cannot overwrite a delivered callback received before sending', async () => {
    const m = (await inbound()).body.data.message;
    const send = jest.spyOn(channels.get('sms'), 'send').mockResolvedValue();
    const out = (
      await request(app.getHttpServer())
        .post(`/conversations/${m.conversationId}/messages`)
        .set(auth)
        .send({ channel: 'sms', body: 'Reply' })
        .expect(202)
    ).body.data;
    await callback(out.providerMessageId, 'delivered');
    await worker.processOne();
    expect(send).not.toHaveBeenCalled();
    expect(
      (await history(m.conversationId)).body.data.items.find(
        (r: { id: string }) => r.id === out.id,
      ).status,
    ).toBe('delivered');
  });
  it('rolls back message, contact and counter if storing the event fails', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await db.query(
      "ALTER TABLE inbox_events ADD CONSTRAINT reject_event CHECK (type <> 'message.new')",
    );
    try {
      const response = await request(app.getHttpServer())
        .post('/webhooks/inbound')
        .set(webhook)
        .send(payload())
        .expect(500);
      expect(response.body).toEqual({
        status: 500,
        message: 'Internal server error',
        data: null,
      });
      expect(log).toHaveBeenCalled();
      expect(
        (await db.query<{ count: string }>('SELECT count(*) FROM messages'))[0]
          .count,
      ).toBe('0');
      expect((await list()).body.data.items).toHaveLength(0);
    } finally {
      await db.query('ALTER TABLE inbox_events DROP CONSTRAINT reject_event');
      log.mockRestore();
    }
  });
  it('enforces tenant boundaries for every agent action and protects webhooks', async () => {
    const m = (await inbound()).body.data.message;
    await request(app.getHttpServer())
      .get('/locations/loc_1/conversations')
      .expect(401);
    await request(app.getHttpServer())
      .get('/locations/loc_1/conversations')
      .set(auth2)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/conversations/${m.conversationId}/messages`)
      .set(auth2)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/conversations/${m.conversationId}/read`)
      .set(auth2)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/conversations/${m.conversationId}`)
      .set(auth2)
      .send({ status: 'closed' })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/conversations/${m.conversationId}/messages`)
      .set(auth2)
      .send({ channel: 'sms', body: 'Leak?' })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/conversations/${m.conversationId}`)
      .set(auth)
      .send({ assignedTo: 'agent_2' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/webhooks/inbound')
      .send(payload())
      .expect(401);
    await request(app.getHttpServer())
      .get('/locations/loc_1/events')
      .set(auth2)
      .expect(403);
  });
  it('SSE streams and replays only events from the authorized location', async () => {
    await inbound(
      payload(undefined, { locationId: 'loc_2', body: 'FOREIGN_SECRET' }),
    );
    const abort = new AbortController();
    const response = await fetch(`${base}/locations/loc_1/events`, {
      headers: { ...auth, 'Last-Event-ID': '0' },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const timeout = setTimeout(() => abort.abort(), 4000);
    try {
      await inbound(payload(undefined, { body: 'OWN_MESSAGE' }));
      const reader = response.body!.getReader();
      let content = '';
      while (!content.includes('OWN_MESSAGE')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        content += new TextDecoder().decode(chunk.value);
      }
      expect(content).toContain('event: message.new');
      expect(content).not.toContain('FOREIGN_SECRET');
      const eventId = /id: (\d+)/.exec(content)![1];
      const m = (await history((await list()).body.data.items[0].id)).body.data
        .items[0];
      await callback(m.providerMessageId, 'read');
      const replayAbort = new AbortController();
      const replayTimer = setTimeout(() => replayAbort.abort(), 4000);
      try {
        const replay = await fetch(`${base}/locations/loc_1/events`, {
          headers: { ...auth, 'Last-Event-ID': eventId },
          signal: replayAbort.signal,
        });
        const r = replay.body!.getReader();
        let content = '';
        while (!content.includes('event: message.status')) {
          const chunk = await r.read();
          if (chunk.done) break;
          content += new TextDecoder().decode(chunk.value);
        }
        expect(content).toContain('"status":"read"');
        expect(content).not.toContain('FOREIGN_SECRET');
      } finally {
        clearTimeout(replayTimer);
        replayAbort.abort();
      }
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  });
  it('validates malformed channels, dates, phone numbers, bodies, IDs and limits', async () => {
    for (const extra of [
      { channel: 'fax' },
      { sentAt: 'yesterday' },
      { from: 'not-a-phone' },
      { body: '' },
    ])
      await request(app.getHttpServer())
        .post('/webhooks/inbound')
        .set(webhook)
        .send(payload(undefined, extra))
        .expect(400);
    await request(app.getHttpServer())
      .get('/conversations/invalid/messages')
      .set(auth)
      .expect(400);
    await request(app.getHttpServer())
      .get('/locations/loc_1/conversations?limit=-1')
      .set(auth)
      .expect(400);
  });
  it('DTOs reject unknown properties, missing fields, wrong types and non-object bodies without writes', async () => {
    const valid = payload();
    for (const body of [
      { ...valid, unexpected: 'not allowed' },
      { ...valid, providerMessageId: null },
      { ...valid, locationId: 1 },
      { ...valid, channel: 'constructor' },
      { ...valid, channel: null },
      { ...valid, body: '   ' },
      { ...valid, from: ['+919876543210'] },
      { ...valid, sentAt: '2026-02-30T10:15:00Z' },
      { ...valid, sentAt: '2026-10-28T24:00:00Z' },
      { ...valid, sentAt: 1793182500000 },
      {},
      [valid],
    ]) {
      const response = await request(app.getHttpServer())
        .post('/webhooks/inbound')
        .set(webhook)
        .send(body)
        .expect(400);
      expect(response.body.status).toBe(400);
      expect(response.body.data).toBeNull();
    }
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM messages'))[0]
        .count,
    ).toBe('0');
  });
  it('status DTO rejects invalid lifecycle values and timestamps before storing orphan states', async () => {
    const valid = {
      providerMessageId: randomUUID(),
      status: 'read',
      timestamp: '2026-10-28T10:16:00Z',
    };
    for (const body of [
      { ...valid, status: 'constructor' },
      { ...valid, status: null },
      { ...valid, timestamp: null },
      { ...valid, timestamp: '2026-02-30T10:16:00Z' },
      { ...valid, locationId: 'loc_2' },
      {},
    ])
      await request(app.getHttpServer())
        .post('/webhooks/status')
        .set(webhook)
        .send(body)
        .expect(400);
    expect(
      (
        await db.query<{ count: string }>(
          'SELECT count(*) FROM provider_states',
        )
      )[0].count,
    ).toBe('0');
  });
  it('send DTO rejects invalid channel/body and extra writable fields before enqueueing', async () => {
    const m = (await inbound()).body.data.message;
    for (const body of [
      { channel: 'fax', body: 'Reply' },
      { channel: 'sms', body: null },
      { channel: 'sms', body: ' ' },
      { channel: 'sms', body: 'Reply', status: 'read' },
      {},
    ])
      await request(app.getHttpServer())
        .post(`/conversations/${m.conversationId}/messages`)
        .set(auth)
        .send(body)
        .expect(400);
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM send_jobs'))[0]
        .count,
    ).toBe('0');
  });
  it('patch DTO rejects empty updates and invalid nullable fields, and preserves omitted assignment', async () => {
    const m = (await inbound()).body.data.message;
    const path = `/conversations/${m.conversationId}`;
    await request(app.getHttpServer())
      .patch(path)
      .set(auth)
      .send({ assignedTo: 'agent_1' })
      .expect(200);
    for (const body of [
      {},
      { status: null },
      { status: 'archived' },
      { assignedTo: 123 },
      { assignedTo: '' },
      { assignedTo: ' ' },
      { unreadCount: 0 },
      [{ status: 'closed' }],
    ]) {
      await request(app.getHttpServer())
        .patch(path)
        .set(auth)
        .send(body)
        .expect(400);
    }
    const updated = await request(app.getHttpServer())
      .patch(path)
      .set(auth)
      .send({ status: 'closed' })
      .expect(200);
    expect(updated.body.data.status).toBe('closed');
    expect(updated.body.data.assignedTo).toBe('agent_1');
    const unassigned = await request(app.getHttpServer())
      .patch(path)
      .set(auth)
      .send({ assignedTo: null })
      .expect(200);
    expect(unassigned.body.data.assignedTo).toBeNull();
    expect(unassigned.body.data.status).toBe('closed');
  });
  it('query DTOs transform decimal limits and reject invalid limits, repeated fields and unknown keys', async () => {
    await inbound();
    await inbound(payload(undefined, { from: '+919000000001' }));
    const first = (await list('?limit=1')).body.data;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=1e2',
      'limit=0x10',
      'limit=',
      'limit=1&limit=2',
      'limit=true',
      'status=archived',
      'assignedTo=',
      'unexpected=value',
      'cursor=bad',
      `cursor=${randomUUID()}:9007199254740992`,
    ]) {
      await request(app.getHttpServer())
        .get(`/locations/loc_1/conversations?${query}`)
        .set(auth)
        .expect(400);
    }
    const m = (await list()).body.data.items[0];
    await request(app.getHttpServer())
      .get(`/conversations/${m.id}/messages?status=open`)
      .set(auth)
      .expect(400);
    await request(app.getHttpServer())
      .get('/locations/loc_1/messages/search?q=offer&extra=value')
      .set(auth)
      .expect(400);
    await request(app.getHttpServer())
      .get('/locations/loc_1/messages/search')
      .set(auth)
      .expect(400);
  });
  it('searches messages with location isolation and full-text matching', async () => {
    await inbound(payload(undefined, { body: 'The offer is still valid' }));
    await inbound(payload(undefined, { body: 'An unrelated message' }));
    await inbound(
      payload(undefined, { locationId: 'loc_2', body: 'The offer is private' }),
    );
    const result = await request(app.getHttpServer())
      .get('/locations/loc_1/messages/search?q=offer')
      .set(auth)
      .expect(200);
    expect(result.body.data.items).toHaveLength(1);
    expect(result.body.data.items[0].body).toBe('The offer is still valid');
  });
  it('migration and seed scripts are repeatable against the isolated database schema', async () => {
    const run = promisify(execFile);
    for (let n = 0; n < 2; n++) {
      await run(process.execPath, ['scripts/migrate.cjs'], {
        env: process.env,
      });
      await run(process.execPath, ['scripts/seed.cjs'], { env: process.env });
    }
    const contacts = await db.query<{ count: string }>(
      'SELECT count(*) FROM contacts',
    );
    expect(contacts[0].count).toBe('1');
    const identities = await db.query<{ count: string }>(
      'SELECT count(*) FROM contact_identities',
    );
    expect(identities[0].count).toBe('2');
    const first = (await inbound()).body.data.message;
    await inbound(
      payload(undefined, {
        channel: 'email',
        from: 'customer@example.com',
        to: 'inbox@example.com',
      }),
    );
    expect((await history(first.conversationId)).body.data.items).toHaveLength(
      2,
    );
  });
  it('enforces composite foreign keys against cross-location references', async () => {
    const m = (await inbound()).body.data.message;
    await expect(
      db.query(
        "INSERT INTO messages(id,location_id,conversation_id,provider_message_id,channel,direction,sender,recipient,body,status,sent_at) VALUES ($1,'loc_2',$2,$3,'sms','inbound','x','y','z','delivered',now())",
        [randomUUID(), m.conversationId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('recovers a persisted retry job using a new worker instance', async () => {
    const m = (await inbound()).body.data.message;
    const send = jest
      .spyOn(channels.get('sms'), 'send')
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue();
    const out = (
      await request(app.getHttpServer())
        .post(`/conversations/${m.conversationId}/messages`)
        .set(auth)
        .send({ channel: 'sms', body: 'Retry me' })
        .expect(202)
    ).body.data;
    await worker.processOne();
    await db.query('UPDATE send_jobs SET next_attempt_at=clock_timestamp()');
    await new SendWorker(db, channels).processOne();
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (await history(m.conversationId)).body.data.items.find(
        (r: { id: string }) => r.id === out.id,
      ).status,
    ).toBe('sent');
  });
});
