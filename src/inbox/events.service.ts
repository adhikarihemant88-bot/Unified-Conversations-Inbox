import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Response } from 'express';
import { MoreThan } from 'typeorm';
import { InboxEvent } from '../entities/inbox-event.entity';
import { DatabaseService } from '../utils/database.service';

@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly connections = new Set<Response>();
  constructor(private readonly db: DatabaseService) {}
  async open(location: number, lastId: unknown, res: Response) {
    if (
      lastId !== undefined &&
      (typeof lastId !== 'string' ||
        !/^\d{1,10}$/.test(lastId) ||
        Number(lastId) > 2147483647)
    )
      throw new BadRequestException('Invalid Last-Event-ID');
    const repository = this.db.getRepository(InboxEvent);
    let cursor =
      typeof lastId === 'string'
        ? Number(lastId)
        : ((
            await repository.findOne({
              where: { locationId: location },
              order: { id: 'DESC' },
              select: { id: true },
            })
          )?.id ?? 0);
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.connections.add(res);
    res.on('close', () => {
      closed = true;
      clearTimeout(timer);
      this.connections.delete(res);
    });
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    let heartbeat = Date.now();
    const poll = async () => {
      if (closed) return;
      try {
        const rows = await repository.find({
          where: { locationId: location, id: MoreThan(cursor) },
          order: { id: 'ASC' },
          take: 100,
        });
        if (closed) return;
        for (const row of rows) {
          if (
            !res.write(
              `id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify(row.payload)}\n\n`,
            )
          ) {
            res.end();
            return;
          }
          cursor = row.id;
        }
        if (Date.now() - heartbeat > 15000) {
          res.write(': heartbeat\n\n');
          heartbeat = Date.now();
        }
        timer = setTimeout(
          () => {
            void poll();
          },
          rows.length === 100 ? 0 : 500,
        );
        timer.unref();
      } catch {
        this.logger.error(
          'Event stream interrupted; reconnect using Last-Event-ID',
        );
        res.end();
      }
    };
    void poll();
  }
  onModuleDestroy() {
    for (const response of this.connections) response.end();
    this.connections.clear();
  }
}
