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
  // Ephemeral typing/presence is fanned out in memory: it is not durable, has
  // no replay and is only visible to streams on this instance.
  private readonly streams = new Map<
    number,
    Set<{ res: Response; agentId?: number }>
  >();
  constructor(private readonly db: DatabaseService) {}

  onlineAgents(location: number): number[] {
    const agents = new Set<number>();
    for (const { agentId } of this.streams.get(location) ?? [])
      if (agentId !== undefined) agents.add(agentId);
    return [...agents].sort((a, b) => a - b);
  }

  publish(location: number, type: string, payload: unknown) {
    for (const stream of this.streams.get(location) ?? []) {
      // No `id:` line, so ephemeral events never move Last-Event-ID.
      if (
        !stream.res.write(
          `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`,
        )
      )
        stream.res.end();
    }
  }

  async open(
    location: number,
    lastId: unknown,
    res: Response,
    agentId?: number,
  ) {
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
    const stream = { res, agentId };
    const wasOnline =
      agentId !== undefined && this.onlineAgents(location).includes(agentId);
    let streams = this.streams.get(location);
    if (!streams) this.streams.set(location, (streams = new Set()));
    streams.add(stream);
    res.on('close', () => {
      closed = true;
      clearTimeout(timer);
      this.connections.delete(res);
      streams.delete(stream);
      if (streams.size === 0) this.streams.delete(location);
      if (
        agentId !== undefined &&
        !this.onlineAgents(location).includes(agentId)
      )
        this.publish(location, 'presence.offline', { agentId });
    });
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    if (agentId !== undefined) {
      res.write(
        `event: presence.snapshot\ndata: ${JSON.stringify({ agentIds: this.onlineAgents(location) })}\n\n`,
      );
      if (!wasOnline) this.publish(location, 'presence.online', { agentId });
    }
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
    this.streams.clear();
  }
}
