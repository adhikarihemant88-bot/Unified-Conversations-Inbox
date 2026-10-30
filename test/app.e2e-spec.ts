import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  INestApplication,
  Logger,
  Post,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

import { DatabaseService } from '../src/utils/database.service';

@Controller('test-responses')
class ResponseTestController {
  @Get('bad-request')
  badRequest() {
    throw new BadRequestException(['Invalid vehicle ID']);
  }

  @Post()
  create() {
    return { id: 1 };
  }

  @Get('empty')
  @HttpCode(204)
  empty() {}
}

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  const query = jest.fn();
  const builder = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    returns: query,
  };
  const from = jest.fn().mockReturnValue(builder);

  beforeEach(async () => {
    query.mockReset();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ResponseTestController],
    })
      .overrideProvider(DatabaseService)
      .useValue({ client: { from } })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(404)
      .expect({ status: 404, data: null, message: 'Cannot GET /' });
  });

  it('formats ticket data once', async () => {
    const tickets = [
      {
        entry_time: '2026-10-28T08:30:00.000Z',
        spot_id: 12,
        vehicle_id: 5,
      },
    ];
    query.mockResolvedValue({ data: tickets, error: null });
    await request(app.getHttpServer()).get('/tickets').expect(200).expect({
      status: 200,
      data: tickets,
      message: 'Tickets fetched successfully',
    });
  });

  it('returns an empty array when no vehicles are parked', async () => {
    query.mockResolvedValue({ data: [], error: null });
    await request(app.getHttpServer()).get('/tickets').expect(200).expect({
      status: 200,
      data: [],
      message: 'Tickets fetched successfully',
    });
  });

  it('returns a real 500 without leaking database errors', async () => {
    query.mockResolvedValue({
      data: null,
      error: new Error('secret database connection details'),
    });
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      await request(app.getHttpServer())
        .get('/tickets')
        .expect(500)
        .expect({ status: 500, data: null, message: 'Internal server error' });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('preserves validation messages and HTTP status', async () => {
    await request(app.getHttpServer())
      .get('/test-responses/bad-request')
      .expect(400)
      .expect({ status: 400, data: null, message: ['Invalid vehicle ID'] });
  });

  it('formats unknown routes', async () => {
    const result = await request(app.getHttpServer())
      .get('/missing')
      .expect(404);
    expect(result.body).toEqual({
      status: 404,
      data: null,
      message: 'Cannot GET /missing',
    });
  });

  it('uses the actual success status', async () => {
    await request(app.getHttpServer())
      .post('/test-responses')
      .expect(201)
      .expect({ status: 201, data: { id: 1 }, message: 'Success' });
  });

  it('preserves responses without a body', async () => {
    const result = await request(app.getHttpServer())
      .get('/test-responses/empty')
      .expect(204);
    expect(result.text).toBe('');
  });

  afterEach(async () => {
    await app.close();
  });
});
