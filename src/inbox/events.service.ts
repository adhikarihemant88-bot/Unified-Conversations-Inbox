import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../utils/database.service';

@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly connections = new Set<Response>();
  constructor(private readonly db: DatabaseService) {}
  async open(location: string, lastId: unknown, res: Response) {
    if (
      lastId !== undefined &&
      (typeof lastId !== 'string' || !/^\d{1,18}$/.test(lastId))
    )
      throw new BadRequestException('Invalid Last-Event-ID');
    let cursor: string =
      typeof lastId === 'string'
        ? lastId
        : (
            await this.db.query<{ id: string }>(
              'SELECT COALESCE(MAX(id),0)::text AS id FROM inbox_events WHERE location_id=$1',
              [location],
            )
          )[0].id;
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
        const rows = await this.db.query<{
          id: string;
          type: string;
          payload: unknown;
        }>(
          'SELECT id::text,type,payload FROM inbox_events WHERE location_id=$1 AND id>$2 ORDER BY id LIMIT 100',
          [location, cursor],
        );
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
