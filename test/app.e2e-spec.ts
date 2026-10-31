import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { DataSource, TableCheck } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/utils/database.service';
import { Channels } from '../src/inbox/channels';
import { SendWorker } from '../src/inbox/send.worker';
import { Contact } from '../src/entities/contact.entity';
import { ContactIdentity } from '../src/entities/contact-identity.entity';
import { Conversation } from '../src/entities/conversation.entity';
import { Location } from '../src/entities/location.entity';
import { Message } from '../src/entities/message.entity';
import { Agent } from '../src/entities/agent.entity';
import { InboxEvent } from '../src/entities/inbox-event.entity';
import { PaginationSnapshot } from '../src/entities/pagination-snapshot.entity';
import { ProviderState } from '../src/entities/provider-state.entity';
import { SendJob } from '../src/entities/send-job.entity';

describe('Inbox (real PostgreSQL)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let schemaDataSource: DataSource;
  let db: DatabaseService;
  let channels: Channels;
  let worker: SendWorker;
  let base: string;
  let locOne: number;
  let locTwo: number;
  let agentOneId: number;
  let agentTwoId: number;
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const auth = { Authorization: 'Bearer test-inbox' };
  const auth2 = { Authorization: 'Bearer test-webhook' };
  const webhook = { Authorization: 'Bearer test-webhook' };
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
  const history = (id: number, query = '') =>
    request(app.getHttpServer())
      .get(`/conversations/${id}/messages${query}`)
      .set(auth)
      .expect(200);
  const makeSendJobsDue = async () => {
    const jobs = await db.getRepository(SendJob).find();
    for (const job of jobs) job.nextAttemptAt = new Date(0);
    await db.getRepository(SendJob).save(jobs);
  };
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'Run npm run test:e2e for a disposable PostgreSQL server',
      );
    admin = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      entities: [],
      synchronize: false,
    });
    await admin.initialize();
    const schemaRunner = admin.createQueryRunner();
    await schemaRunner.createSchema(schema);
    await schemaRunner.release();
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    await promisify(execFile)(process.execPath, ['scripts/migrate.cjs'], {
      env: process.env,
    });
    schemaDataSource = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [InboxEvent],
      synchronize: false,
    });
    await schemaDataSource.initialize();
    process.env.WEBHOOK_TOKEN = 'test-webhook';
    process.env.ADMIN_TOKEN = 'test-admin';
    process.env.INBOX_TOKEN = 'test-inbox';
    process.env.INBOX_LOCATION_TOKENS = 'loc_1:test-loc1,loc_2:test-loc2';
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
    await db.ormTransaction(async (manager) => {
      await manager
        .getRepository(PaginationSnapshot)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(InboxEvent)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(SendJob)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(ProviderState)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(Message)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(Conversation)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(ContactIdentity)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(Contact)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(Agent)
        .createQueryBuilder()
        .delete()
        .execute();
      await manager
        .getRepository(Location)
        .createQueryBuilder()
        .delete()
        .execute();
      const locations = manager.getRepository(Location);
      const [one, two] = await locations.save([
        locations.create({ name: 'loc_1' }),
        locations.create({ name: 'loc_2' }),
      ]);
      locOne = one.id;
      locTwo = two.id;
      const agents = manager.getRepository(Agent);
      const [agentOne, agentTwo] = await agents.save([
        agents.create({
          name: 'Agent One',
        }),
        agents.create({
          name: 'Agent Two',
        }),
      ]);
      agentOneId = agentOne.id;
      agentTwoId = agentTwo.id;
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (schemaDataSource) await schemaDataSource.destroy();
    if (admin) {
      const schemaRunner = admin.createQueryRunner();
      await schemaRunner.dropSchema(schema, true, true);
      await schemaRunner.release();
      await admin.destroy();
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
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(
      responses.filter((r) => r.body.data.duplicate === false),
    ).toHaveLength(1);
    expect(
      responses.filter((r) => r.body.data.duplicate === true),
    ).toHaveLength(29);
    expect((await list()).body.data[0].unreadCount).toBe(1);
    expect(await db.getRepository(Message).count()).toBe(1);
    expect(await db.getRepository(InboxEvent).count()).toBe(1);
  });
  it('creates an agent using the admin bearer token', async () => {
    await request(app.getHttpServer())
      .post('/admin/agents')
      .set('Authorization', 'Bearer test-inbox')
      .send({ name: 'New agent' })
      .expect(401);

    const response = await request(app.getHttpServer())
      .post('/admin/agents')
      .set('Authorization', 'Bearer test-admin')
      .send({ name: 'New agent' })
      .expect(201);
    expect(response.body.data).toMatchObject({
      id: expect.any(Number),
      name: 'New agent',
    });
    await request(app.getHttpServer())
      .post('/admin/agents')
      .set('Authorization', 'Bearer test-admin')
      .send({ name: ' new agent ' })
      .expect(409);
    await request(app.getHttpServer())
      .get('/locations/loc_1/conversations')
      .set(auth)
      .expect(200);
  });
  it('does not create duplicate agents for simultaneous requests', async () => {
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/admin/agents')
        .set('Authorization', 'Bearer test-admin')
        .send({ name: 'Support Agent 1' }),
      request(app.getHttpServer())
        .post('/admin/agents')
        .set('Authorization', 'Bearer test-admin')
        .send({ name: 'Support Agent 1' }),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([201, 409]);
    expect(
      await db.ormTransaction((manager) =>
        manager.getRepository(Agent).countBy({ name: 'Support Agent 1' }),
      ),
    ).toBe(1);
  });
  it('assigns new conversations to the least recently assigned agent', async () => {
    const thirdAgent = await db.ormTransaction((manager) =>
      manager.getRepository(Agent).save(
        manager.getRepository(Agent).create({
          name: 'Third agent',
        }),
      ),
    );
    const conversationIds: number[] = [];
    for (const suffix of ['1', '2', '3']) {
      const response = await inbound(
        payload(undefined, { from: `+91900000000${suffix}` }),
      );
      conversationIds.push(response.body.data.message.conversationId);
    }
    const rows = (await list()).body.data;
    const assignmentByConversation = new Map(
      rows.map((row: { conversationId: number; assignedTo: number }) => [
        row.conversationId,
        row.assignedTo,
      ]),
    );
    expect(
      conversationIds.map((id) => assignmentByConversation.get(id)),
    ).toEqual([agentOneId, agentTwoId, thirdAgent.id]);
  });
  it('coordinates global agent assignment across different locations', async () => {
    const [one, two] = await Promise.all([
      inbound(
        payload(undefined, {
          locationId: 'loc_1',
          from: '+919100000001',
        }),
      ),
      inbound(
        payload(undefined, {
          locationId: 'loc_2',
          from: '+919100000002',
        }),
      ),
    ]);
    const assigned = [
      one.body.data.message.conversationId,
      two.body.data.message.conversationId,
    ];
    const rows = await db.getRepository(Conversation).find({
      where: assigned.map((id) => ({ id })),
      order: { id: 'ASC' },
    });
    expect(rows.map((row) => row.assignedTo).sort((a, b) => a - b)).toEqual(
      [agentOneId, agentTwoId].sort((a, b) => a - b),
    );
  });
  it.each([
    {
      kind: 'phone',
      senders: [
        { channel: 'sms', from: '+91 98765 43210', to: '+91 80000 00000' },
        {
          channel: 'whatsapp',
          from: 'whatsapp:+919876543210',
          to: '+918000000000',
        },
        { channel: 'sms', from: '+91 80000 00000', to: '+91 98765 43210' },
        {
          channel: 'whatsapp',
          from: 'whatsapp:+918000000000',
          to: '+919876543210',
        },
      ],
    },
    {
      kind: 'email',
      senders: [
        {
          channel: 'email',
          from: 'Customer@Example.com',
          to: 'inbox@example.com',
        },
        {
          channel: 'email',
          from: 'customer@example.com',
          to: 'inbox@example.com',
        },
        {
          channel: 'email',
          from: 'Inbox@Example.com',
          to: 'Customer@Example.com',
        },
      ],
    },
  ])(
    '50 parallel first $kind messages in both directions create two contacts and one conversation with unreadCount=50',
    async ({ senders }) => {
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          inbound(payload(undefined, senders[i % senders.length])),
        ),
      );
      const rows = (await list()).body.data;
      expect(rows).toHaveLength(1);
      expect(rows[0].unreadCount).toBe(50);
      expect(await db.getRepository(Contact).count()).toBe(2);
      expect(
        await db.ormTransaction((manager) =>
          manager.getRepository(ContactIdentity).count(),
        ),
      ).toBe(2);
      expect(await db.getRepository(Message).count()).toBe(50);
      const events = await db.getRepository(InboxEvent).find({
        order: { id: 'ASC' },
      });
      expect(events.map((e) => e.payload.conversation.unreadCount)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
    },
  );
  it('keeps A-B and A-C as separate conversations at the same location', async () => {
    const first = (await inbound()).body.data.message;
    const thirdAddress = '+917000000000';
    const second = (await inbound(payload(undefined, { to: thirdAddress })))
      .body.data.message;
    const reply = (
      await inbound(
        payload(undefined, { from: thirdAddress, to: '+919876543210' }),
      )
    ).body.data.message;
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(reply.conversationId).toBe(second.conversationId);
    expect((await list()).body.data).toHaveLength(2);
    expect((await history(first.conversationId)).body.data.items).toHaveLength(
      1,
    );
    expect((await history(second.conversationId)).body.data.items).toHaveLength(
      2,
    );
    expect(
      await db.ormTransaction((manager) =>
        manager.getRepository(Contact).count(),
      ),
    ).toBe(3);
  });
  it('unifies normalized SMS/WhatsApp phone identities and explicitly linked email', async () => {
    const first = (await inbound()).body.data.message;
    await db.ormTransaction(async (manager) => {
      const identities = manager.getRepository(ContactIdentity);
      for (const [phone, email] of [
        ['+919876543210', 'customer@example.com'],
        ['+918000000000', 'inbox@example.com'],
      ]) {
        const identity = await identities.findOneByOrFail({
          locationId: locOne,
          kind: 'phone',
          value: phone,
        });
        await identities.insert({
          locationId: locOne,
          contactId: identity.contactId,
          kind: 'email',
          value: email,
        });
      }
    });
    const whatsapp = (
      await inbound(
        payload(undefined, {
          channel: 'whatsapp',
          from: 'whatsapp:+919876543210',
        }),
      )
    ).body.data.message;
    const email = (
      await inbound(
        payload(undefined, {
          channel: 'email',
          from: 'Customer@Example.com',
          to: 'inbox@example.com',
        }),
      )
    ).body.data.message;
    expect(whatsapp.conversationId).toBe(first.conversationId);
    expect(email.conversationId).toBe(first.conversationId);
    const summaries = (await list()).body.data;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].conversationId).toBe(first.conversationId);
    expect(summaries[0].lastMessageChannel).toBe('email');
    expect((await history(first.conversationId)).body.data.items).toHaveLength(
      3,
    );
    const outbound = await request(app.getHttpServer())
      .post(`/conversations/${first.conversationId}/messages`)
      .set(auth)
      .send({ channel: 'whatsapp', body: 'Reply using the same pair' })
      .expect(202);
    expect(outbound.body.data).toMatchObject({
      conversationId: first.conversationId,
      from: '+918000000000',
      to: '+919876543210',
      status: 'queued',
    });
  });
  it.each([
    { channel: 'sms', from: '+91 98765 43210', to: '+91 80000 00000' },
    { channel: 'email', from: 'customer@example.com', to: 'inbox@example.com' },
  ])(
    'merges both directions of a $channel pair within each location and separates locations',
    async (sender) => {
      const first = (await inbound(payload(undefined, sender))).body.data
        .message;
      const second = (
        await inbound(payload(undefined, { ...sender, locationId: 'loc_2' }))
      ).body.data.message;
      const reversed = { ...sender, from: sender.to, to: sender.from };
      const firstReply = (await inbound(payload(undefined, reversed))).body.data
        .message;
      const secondReply = (
        await inbound(payload(undefined, { ...reversed, locationId: 'loc_2' }))
      ).body.data.message;
      expect(firstReply.conversationId).toBe(first.conversationId);
      expect(secondReply.conversationId).toBe(second.conversationId);
      expect(second.conversationId).not.toBe(first.conversationId);
      expect(await db.getRepository(Contact).count()).toBe(4);
      expect(await db.getRepository(Conversation).count()).toBe(2);
      expect((await list()).body.data).toHaveLength(1);
    },
  );
  it('parallel SMS, WhatsApp and email messages share one conversation for a linked pair', async () => {
    const [first, second] = await db.ormTransaction(async (manager) => {
      const contacts = manager.getRepository(Contact);
      const created = await contacts.save([
        contacts.create({ locationId: locOne }),
        contacts.create({ locationId: locOne }),
      ]);
      const [first, second] = created.map((contact) => contact.id);
      await manager.getRepository(ContactIdentity).insert([
        {
          locationId: locOne,
          contactId: first,
          kind: 'phone',
          value: '+919876543210',
        },
        {
          locationId: locOne,
          contactId: first,
          kind: 'email',
          value: 'customer@example.com',
        },
        {
          locationId: locOne,
          contactId: second,
          kind: 'phone',
          value: '+918000000000',
        },
        {
          locationId: locOne,
          contactId: second,
          kind: 'email',
          value: 'inbox@example.com',
        },
      ]);
      return created.map((contact) => contact.id);
    });
    const senders = [
      { channel: 'sms', from: '+91 98765 43210', to: '+91 80000 00000' },
      {
        channel: 'whatsapp',
        from: 'whatsapp:+919876543210',
        to: '+918000000000',
      },
      {
        channel: 'email',
        from: 'customer@example.com',
        to: 'inbox@example.com',
      },
      { channel: 'sms', from: '+918000000000', to: '+919876543210' },
      {
        channel: 'email',
        from: 'Inbox@Example.com',
        to: 'Customer@Example.com',
      },
    ];
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        inbound(payload(undefined, senders[i % senders.length])),
      ),
    );
    const rows = (await list()).body.data;
    expect(rows).toHaveLength(1);
    expect([first, second]).toContain(rows[0].contactId);
    expect(rows[0].unreadCount).toBe(50);
    expect(
      new Set(responses.map((r) => r.body.data.message.conversationId)),
    ).toEqual(new Set([rows[0].conversationId]));
    expect(await db.getRepository(Contact).count()).toBe(2);
  });
  it('reuses the existing location and contact without changing their details', async () => {
    const id = await db.ormTransaction(async (manager) => {
      const contact = await manager.getRepository(Contact).save(
        manager.getRepository(Contact).create({
          locationId: locOne,
          name: 'Existing customer',
        }),
      );
      await manager.getRepository(ContactIdentity).insert({
        locationId: locOne,
        contactId: contact.id,
        kind: 'phone',
        value: '+919876543210',
      });
      return contact.id;
    });
    const first = (await inbound()).body.data.message;
    const second = (await inbound()).body.data.message;
    expect(second.conversationId).toBe(first.conversationId);
    const conversation = (await list()).body.data[0];
    expect(conversation.contactId).toBe(id);
    const contacts = await db.ormTransaction((manager) =>
      manager.getRepository(Contact).find(),
    );
    expect(contacts).toHaveLength(2);
    expect(contacts.find((contact) => contact.id === id)?.name).toBe(
      'Existing customer',
    );
    const location = await db.ormTransaction((manager) =>
      manager.getRepository(Location).findOneByOrFail({ id: locOne }),
    );
    expect(location.name).toBe('loc_1');
    expect((await list()).body.data[0].unreadCount).toBe(2);
  });
  it('creates a missing location and continues storing the inbound message', async () => {
    const locationId = 'loc_new';
    const response = await inbound(payload(undefined, { locationId }));
    await db.ormTransaction(async (manager) => {
      const location = await manager
        .getRepository(Location)
        .findOneByOrFail({ name: locationId });
      expect(location.name).toBe(locationId);
      expect(location.id).toEqual(expect.any(Number));
      expect(location.id).toBeGreaterThan(0);
      const message = await manager
        .getRepository(Message)
        .findOneByOrFail({ id: response.body.data.message.id });
      expect(message.locationId).toBe(location.id);
      const conversation = await manager
        .getRepository(Conversation)
        .findOneByOrFail({ id: message.conversationId });
      expect(conversation.locationId).toBe(location.id);
      expect(conversation.unreadCount).toBe(1);
      for (const id of [
        conversation.participantAId,
        conversation.participantBId,
      ]) {
        const contact = await manager
          .getRepository(Contact)
          .findOneByOrFail({ id });
        expect(contact.locationId).toBe(location.id);
      }
    });
  });
  it('creates one missing location for concurrent inbound messages', async () => {
    const locationId = 'loc_new';
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        inbound(payload(undefined, { locationId })),
      ),
    );
    expect(
      new Set(responses.map((r) => r.body.data.message.conversationId)).size,
    ).toBe(1);
    await db.ormTransaction(async (manager) => {
      expect(
        await manager.getRepository(Location).countBy({ name: locationId }),
      ).toBe(1);
      const location = await manager
        .getRepository(Location)
        .findOneByOrFail({ name: locationId });
      expect(
        await manager
          .getRepository(Message)
          .countBy({ locationId: location.id }),
      ).toBe(10);
      const conversation = await manager
        .getRepository(Conversation)
        .findOneByOrFail({ locationId: location.id });
      expect(conversation.unreadCount).toBe(10);
    });
  });
  it('rejects a reused provider ID with different payload/location', async () => {
    const body = payload();
    await inbound(body);
    await request(app.getHttpServer())
      .post('/webhooks/inbound')
      .set(webhook)
      .send({ ...body, locationId: 'loc_new' })
      .expect(409);
    expect(
      await db.ormTransaction((manager) =>
        manager.getRepository(Location).existsBy({ name: 'loc_new' }),
      ),
    ).toBe(false);
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
      .send({ status: 'closed', assignedTo: agentOneId })
      .expect(200);
    expect((await inbound(body)).body.data.duplicate).toBe(true);
    expect((await list()).body.data[0].status).toBe('closed');
    await inbound();
    expect((await list()).body.data[0].status).toBe('open');
    expect(
      (await list(`?status=open&assignedTo=${agentOneId}`)).body.data,
    ).toHaveLength(1);
  });
  it('returns conversation summaries with the latest channel and root pagination metadata', async () => {
    await inbound();
    const response = await list('?limit=1');

    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      contactId: expect.any(Number),
      lastMessageChannel: 'sms',
      status: 'open',
      assignedTo: agentOneId,
      lastMessagePreview: 'Hello',
      unreadCount: 1,
    });
    expect(response.body.data[0]).toHaveProperty('conversationId');
    expect(response.body.data[0]).not.toHaveProperty('id');
    expect(response.body.data[0]).not.toHaveProperty('contact');
    expect(response.body.data[0]).not.toHaveProperty('participantAId');
    expect(response.body.data[0]).not.toHaveProperty('participantBId');
    expect(response.body.data[0]).not.toHaveProperty('messages');
    expect(response.body).toHaveProperty('nextCursor', null);
    expect(response.body).toHaveProperty('hasMore', false);
  });
  it('outbound replies reverse the latest inbound direction within the same conversation', async () => {
    const first = (await inbound()).body.data.message;
    const send = () =>
      request(app.getHttpServer())
        .post(`/conversations/${first.conversationId}/messages`)
        .set(auth)
        .send({ channel: 'sms', body: 'Reply' })
        .expect(202);
    expect((await send()).body.data).toMatchObject({
      conversationId: first.conversationId,
      from: '+918000000000',
      to: '+919876543210',
    });
    const reply = (
      await inbound(
        payload(undefined, {
          from: '+918000000000',
          to: '+919876543210',
          sentAt: '2026-10-28T10:16:00Z',
        }),
      )
    ).body.data.message;
    expect(reply.conversationId).toBe(first.conversationId);
    expect((await send()).body.data).toMatchObject({
      conversationId: first.conversationId,
      from: '+919876543210',
      to: '+918000000000',
    });
    expect((await list()).body.data).toHaveLength(1);
    expect((await history(first.conversationId)).body.data.items).toHaveLength(
      4,
    );
  });
  it('rejects outbound channels without identities for both participants', async () => {
    const first = (await inbound()).body.data.message;
    await request(app.getHttpServer())
      .post(`/conversations/${first.conversationId}/messages`)
      .set(auth)
      .send({ channel: 'email', body: 'Reply' })
      .expect(400);
    expect((await history(first.conversationId)).body.data.items).toHaveLength(
      1,
    );
  });
  it('late older messages leave the latest preview intact', async () => {
    await inbound(
      payload(undefined, { body: 'Latest', sentAt: '2026-10-29T10:00:00Z' }),
    );
    await inbound(payload(undefined, { body: 'Older' }));
    const c = (await list()).body.data[0];
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
    const before = (await list()).body.data[0].unreadCount;
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThanOrEqual(20);
    const events = await db.getRepository(InboxEvent).find({
      select: { type: true },
      order: { id: 'ASC' },
    });
    let expected = 0;
    for (const e of events)
      expected = e.type === 'message.new' ? expected + 1 : 0;
    expect(before).toBe(expected);
    await request(app.getHttpServer())
      .post(`/conversations/${m.conversationId}/read`)
      .set(auth)
      .expect(200);
    await Promise.all(Array.from({ length: 10 }, () => inbound()));
    expect((await list()).body.data[0].unreadCount).toBe(10);
  });
  it('message snapshot pages handle timestamp ties and late inserts', async () => {
    const ids: number[] = [];
    for (let n = 0; n < 5; n++)
      ids.push((await inbound()).body.data.message.id);
    const c = (await list()).body.data[0].conversationId;
    let page = (await history(c, '?limit=2')).body.data;
    const seen = [...page.items];
    await inbound(payload(undefined, { sentAt: '2026-10-20T00:00:00Z' }));
    await inbound();
    while (page.nextCursor) {
      page = (await history(c, `?limit=2&cursor=${page.nextCursor}`)).body.data;
      seen.push(...page.items);
    }
    const compare = (a: number, b: number) => a - b;
    expect(seen.map((m) => m.id as number).sort(compare)).toEqual(
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
    const page = await list('?limit=1');
    expect(page.body.nextCursor).toMatch(/^\d+:\d+$/);
    expect(page.body.data[0].conversationId).toBe(a.conversationId);
    await inbound(
      payload(undefined, {
        from: '+919000000002',
        sentAt: '2026-10-29T12:00:00Z',
      }),
    );
    await inbound(payload(undefined, { from: '+919000000003' }));
    const second = await list(`?limit=1&cursor=${page.body.nextCursor}`);
    expect(
      second.body.data.map((c: { conversationId: number }) => c.conversationId),
    ).toEqual([b.conversationId]);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.hasMore).toBe(false);
  });
  it('rejects expired cursors and cursors reused with different filters', async () => {
    await inbound();
    await inbound(payload(undefined, { from: '+919000000001' }));
    const page = await list('?limit=1');
    await request(app.getHttpServer())
      .get(
        `/locations/loc_1/conversations?status=open&cursor=${page.body.nextCursor}`,
      )
      .set(auth)
      .expect(410);
    const snapshots = await db.getRepository(PaginationSnapshot).find();
    for (const snapshot of snapshots)
      snapshot.expiresAt = new Date(Date.now() - 1000);
    await db.getRepository(PaginationSnapshot).save(snapshots);
    await request(app.getHttpServer())
      .get(`/locations/loc_1/conversations?cursor=${page.body.nextCursor}`)
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
        (r: { id: number }) => r.id === out.id,
      ).status,
    ).toBe('sent');
    expect((await list()).body.data[0].unreadCount).toBe(1);
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
    expect((await db.getRepository(SendJob).find())[0].attempts).toBe(1);
    for (let n = 0; n < 2; n++) {
      await makeSendJobsDue();
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
        (r: { id: number }) => r.id === out.id,
      ).status,
    ).toBe('delivered');
  });
  it.each(['loc_1', 'loc_new'])(
    'rolls back inbound state for %s if storing the event fails',
    async (locationId) => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const runner = schemaDataSource.createQueryRunner();
      await runner.createCheckConstraint(
        'inbox_events',
        new TableCheck({
          name: 'reject_event',
          expression: `"type" <> 'message.new'`,
        }),
      );
      try {
        const response = await request(app.getHttpServer())
          .post('/webhooks/inbound')
          .set(webhook)
          .send(payload(undefined, { locationId }))
          .expect(500);
        expect(response.body).toEqual({
          status: 500,
          message: 'Internal server error',
          data: null,
        });
        expect(log).toHaveBeenCalled();
        expect(await db.getRepository(Message).count()).toBe(0);
        expect((await list()).body.data).toHaveLength(0);
        expect(
          await db.ormTransaction((manager) =>
            manager.getRepository(Contact).count(),
          ),
        ).toBe(0);
        expect(
          await db.ormTransaction((manager) =>
            manager.getRepository(ContactIdentity).count(),
          ),
        ).toBe(0);
        expect(
          await db.ormTransaction((manager) =>
            manager.getRepository(Location).existsBy({ name: locationId }),
          ),
        ).toBe(locationId === 'loc_1');
      } finally {
        await runner.dropCheckConstraint(
          'inbox_events',
          new TableCheck({
            name: 'reject_event',
            expression: `"type" <> 'message.new'`,
          }),
        );
        await runner.release();
        log.mockRestore();
      }
    },
  );
  it('requires the module bearer and takes location from the API path', async () => {
    const m = (await inbound()).body.data.message;
    await request(app.getHttpServer())
      .get('/locations/loc_1/conversations')
      .expect(401);
    await request(app.getHttpServer())
      .get('/locations/loc_1/conversations')
      .set(auth2)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/conversations/${m.conversationId}/messages`)
      .set(auth2)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/conversations/${m.conversationId}/read`)
      .set(auth2)
      .expect(401);
    await request(app.getHttpServer())
      .patch(`/conversations/${m.conversationId}`)
      .set(auth2)
      .send({ status: 'closed' })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/conversations/${m.conversationId}/messages`)
      .set(auth2)
      .send({ channel: 'sms', body: 'Leak?' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/locations/loc_2/conversations')
      .set(auth)
      .expect(200);
    const assigned = await request(app.getHttpServer())
      .patch(`/conversations/${m.conversationId}`)
      .set(auth)
      .send({ assignedTo: agentTwoId })
      .expect(200);
    expect(assigned.body.data.assignedTo).toBe(agentTwoId);
    await request(app.getHttpServer())
      .post('/webhooks/inbound')
      .send(payload())
      .expect(401);
    await request(app.getHttpServer())
      .post('/webhooks/inbound')
      .set(auth)
      .send(payload())
      .expect(401);
    await request(app.getHttpServer())
      .get('/locations/loc_1/events')
      .set(auth2)
      .expect(401);
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
      const m = (await history((await list()).body.data[0].conversationId)).body
        .data.items[0];
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
  it('50 parallel inbound messages to one conversation give unreadCount 50', async () => {
    await inbound(payload());
    await Promise.all(
      Array.from({ length: 49 }, () =>
        request(app.getHttpServer())
          .post('/webhooks/inbound')
          .set(webhook)
          .send(payload())
          .expect(200),
      ),
    );
    const conversations = (await list()).body.data;
    expect(conversations).toHaveLength(1);
    expect(conversations[0].unreadCount).toBe(50);
    expect(await db.getRepository(Message).count()).toBe(50);
  });
  it('replayed identical webhook is acknowledged once without side effects', async () => {
    const body = payload();
    const first = await inbound(body);
    expect(first.body.data.duplicate).toBe(false);
    const again = await inbound(body);
    expect(again.body.data.duplicate).toBe(true);
    expect(again.body.data.message.id).toBe(first.body.data.message.id);
    expect(await db.getRepository(InboxEvent).count()).toBe(1);
    expect((await list()).body.data[0].unreadCount).toBe(1);
  });
  it('location-scoped tokens cannot read, write or stream another location', async () => {
    const m = (await inbound()).body.data.message;
    const loc1 = { Authorization: 'Bearer test-loc1' };
    const loc2 = { Authorization: 'Bearer test-loc2' };
    const http = () => request(app.getHttpServer());
    await http().get('/locations/loc_1/conversations').set(loc1).expect(200);
    await http().get('/locations/loc_1/conversations').set(loc2).expect(403);
    await http().get('/locations/loc_1/events').set(loc2).expect(403);
    await http()
      .get('/locations/loc_1/messages/search?q=Hello')
      .set(loc2)
      .expect(403);
    await http()
      .get(`/conversations/${m.conversationId}/messages`)
      .set(loc1)
      .expect(200);
    for (const req of [
      http().get(`/conversations/${m.conversationId}/messages`),
      http().post(`/conversations/${m.conversationId}/read`),
      http()
        .patch(`/conversations/${m.conversationId}`)
        .send({ status: 'closed' }),
      http()
        .post(`/conversations/${m.conversationId}/messages`)
        .send({ channel: 'sms', body: 'x' }),
    ])
      await req.set(loc2).expect(403);
    await http().get('/conversations/999999/messages').set(loc2).expect(404);
    await http()
      .get('/locations/loc_1/conversations')
      .set({ Authorization: 'Bearer nope' })
      .expect(401);
    await http().get('/locations/loc_2/conversations').set(auth).expect(200);
    await http().get('/locations/loc_1/conversations').set(webhook).expect(401);
  });
  it('streams typing and presence only to the same location', async () => {
    const m = (await inbound()).body.data.message;
    const read = async (
      path: string,
      until: string[],
      abort: AbortController,
    ) => {
      const response = await fetch(`${base}${path}`, {
        headers: auth,
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      let content = '';
      return {
        wait: async () => {
          while (!until.every((u) => content.includes(u))) {
            const chunk = await reader.read();
            if (chunk.done) break;
            content += new TextDecoder().decode(chunk.value);
          }
          return content;
        },
        text: () => content,
      };
    };
    const own = new AbortController();
    const foreign = new AbortController();
    const watcher = new AbortController();
    const timer = setTimeout(() => {
      own.abort();
      foreign.abort();
      watcher.abort();
    }, 8000);
    try {
      const ownStream = await read(
        '/locations/loc_1/events',
        ['"typing":true', 'presence.online'],
        own,
      );
      const foreignStream = await read(
        `/locations/loc_2/events?agentId=${agentTwoId}`,
        [],
        foreign,
      );
      // Another agent connects at loc_1 and is announced to the first stream.
      await read(
        `/locations/loc_1/events?agentId=${agentOneId}`,
        ['presence.snapshot'],
        watcher,
      ).then((s) => s.wait());
      await request(app.getHttpServer())
        .post('/locations/loc_1/typing')
        .set(auth)
        .send({
          conversationId: m.conversationId,
          agentId: agentOneId,
          typing: true,
        })
        .expect(202);
      const content = await ownStream.wait();
      expect(content).toContain('event: typing');
      expect(content).toContain(`"agentId":${agentOneId}`);
      expect(content).not.toMatch(/^id: /m);
      expect(foreignStream.text()).not.toContain('typing');
      expect(foreignStream.text()).not.toContain(`"agentId":${agentOneId}`);
      const presence = await request(app.getHttpServer())
        .get('/locations/loc_1/presence')
        .set(auth)
        .expect(200);
      expect(presence.body.data.agentIds).toEqual([agentOneId]);
      // Typing for a conversation that belongs to another location is rejected.
      await request(app.getHttpServer())
        .post('/locations/loc_2/typing')
        .set(auth)
        .send({
          conversationId: m.conversationId,
          agentId: agentOneId,
          typing: true,
        })
        .expect(404);
      await request(app.getHttpServer())
        .post('/locations/loc_1/typing')
        .set(auth)
        .send({
          conversationId: m.conversationId,
          agentId: 999999,
          typing: true,
        })
        .expect(400);
    } finally {
      clearTimeout(timer);
      own.abort();
      foreign.abort();
      watcher.abort();
    }
    await new Promise((r) => setTimeout(r, 100));
    const after = await request(app.getHttpServer())
      .get('/locations/loc_1/presence')
      .set(auth)
      .expect(200);
    expect(after.body.data.agentIds).toEqual([]);
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
    expect(await db.getRepository(Message).count()).toBe(0);
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
    expect(await db.getRepository(ProviderState).count()).toBe(0);
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
    expect(await db.getRepository(SendJob).count()).toBe(0);
  });
  it('patch DTO rejects empty updates and invalid nullable fields, and preserves omitted assignment', async () => {
    const m = (await inbound()).body.data.message;
    const path = `/conversations/${m.conversationId}`;
    await request(app.getHttpServer())
      .patch(path)
      .set(auth)
      .send({ assignedTo: agentOneId })
      .expect(200);
    for (const body of [
      {},
      { status: null },
      { status: 'archived' },
      { assignedTo: 'agent_1' },
      { assignedTo: 0 },
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
    expect(updated.body.data.assignedTo).toBe(agentOneId);
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
    const first = await list('?limit=1');
    expect(first.body.data).toHaveLength(1);
    expect(first.body.nextCursor).not.toBeNull();
    expect(first.body.hasMore).toBe(true);
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
      'cursor=9007199254740992:0',
    ]) {
      await request(app.getHttpServer())
        .get(`/locations/loc_1/conversations?${query}`)
        .set(auth)
        .expect(400);
    }
    const m = (await list()).body.data[0];
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
  it('uses incrementing integer IDs for generated entities', async () => {
    const first = (await inbound()).body.data.message;
    const second = (
      await inbound(payload(undefined, { body: 'A second message' }))
    ).body.data.message;
    expect(Number.isInteger(first.id)).toBe(true);
    expect(second.id).toBeGreaterThan(first.id);
    expect(Number.isInteger(first.conversationId)).toBe(true);
    expect(Number.isInteger(agentOneId)).toBe(true);
    const conversations = await list();
    expect(Number.isInteger(conversations.body.data[0].conversationId)).toBe(
      true,
    );

    const contacts = await db.ormTransaction((manager) =>
      manager.getRepository(Contact).find({ order: { id: 'ASC' } }),
    );
    expect(contacts.map((contact) => contact.id)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(contacts[1].id).toBeGreaterThan(contacts[0].id);
    const snapshot = await db
      .getRepository(PaginationSnapshot)
      .findOneByOrFail({ locationId: locOne });
    const event = await db.getRepository(InboxEvent).findOneByOrFail({
      locationId: locOne,
    });
    expect(Number.isInteger(snapshot.id)).toBe(true);
    expect(Number.isInteger(event.id)).toBe(true);
    expect(new Agent()).not.toHaveProperty('locationId');
  });
  it('migration and seed scripts are repeatable against the isolated database schema', async () => {
    const run = promisify(execFile);
    for (let n = 0; n < 2; n++) {
      await run(process.execPath, ['scripts/migrate.cjs'], {
        env: process.env,
      });
      await run(process.execPath, ['scripts/seed.cjs'], { env: process.env });
    }
    expect(await db.getRepository(Contact).count()).toBe(2);
    expect(await db.getRepository(ContactIdentity).count()).toBe(4);
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
      db.ormTransaction((manager) =>
        manager.getRepository(Message).save(
          manager.getRepository(Message).create({
            locationId: locTwo,
            conversationId: m.conversationId,
            providerMessageId: randomUUID(),
            channel: 'sms',
            direction: 'inbound',
            from: 'x',
            to: 'y',
            body: 'z',
            status: 'delivered',
            sentAt: new Date(),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const conversation = await db.ormTransaction((manager) =>
      manager
        .getRepository(Conversation)
        .findOneByOrFail({ id: m.conversationId }),
    );
    const outsiderId = await db.ormTransaction(async (manager) => {
      const outsider = await manager
        .getRepository(Contact)
        .save(manager.getRepository(Contact).create({ locationId: locTwo }));
      return outsider.id;
    });
    const [participantAId, participantBId] = [
      conversation.participantAId,
      outsiderId,
    ].sort((a, b) => a - b);
    await expect(
      db.ormTransaction((manager) =>
        manager.getRepository(Conversation).insert({
          locationId: locOne,
          participantAId,
          participantBId,
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db.ormTransaction((manager) =>
        manager.getRepository(Conversation).insert({
          locationId: locOne,
          participantAId: conversation.participantBId,
          participantBId: conversation.participantAId,
        }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
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
    await makeSendJobsDue();
    await new SendWorker(db, channels).processOne();
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (await history(m.conversationId)).body.data.items.find(
        (r: { id: number }) => r.id === out.id,
      ).status,
    ).toBe('sent');
  });
});
