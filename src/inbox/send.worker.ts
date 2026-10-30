import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../utils/database.service';
import { Channels } from './channels';
import type { Channel, DeliveryStatus } from './domain';
import { applyStatus, providerLock } from '../webhook/webhook.storage';

@Injectable()
export class SendWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private active?: Promise<void>;
  private ticks = 0;
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: Channels,
  ) {}
  onModuleInit() {
    if (process.env.WORKER_ENABLED !== 'false') this.schedule();
  }
  private schedule() {
    this.timer = setTimeout(() => {
      this.active = this.tick()
        .catch((error: unknown) =>
          this.logger.error(
            'Send worker tick failed; pending jobs will be retried',
            error instanceof Error ? error.stack : String(error),
          ),
        )
        .finally(() => {
          if (!this.stopping) this.schedule();
        });
    }, 250);
    this.timer.unref();
  }
  private async tick() {
    for (let i = 0; i < 20 && !this.stopping; i++)
      if (!(await this.processOne())) break;
    if (++this.ticks % 240 === 0)
      await this.db.query(
        'DELETE FROM pagination_snapshots WHERE expires_at<clock_timestamp()',
      );
  }
  async processOne(): Promise<boolean> {
    return this.db.transaction(async (c) => {
      const job = (
        await c.query<{
          message_id: string;
          attempts: number;
        }>(`SELECT message_id,attempts FROM send_jobs WHERE state='pending' AND next_attempt_at<=clock_timestamp()
        ORDER BY next_attempt_at,message_id LIMIT 1 FOR UPDATE SKIP LOCKED`)
      ).rows[0];
      if (!job) return false;
      const message = (
        await c.query<{
          provider_message_id: string;
          channel: Channel;
          recipient: string;
          body: string;
          status: DeliveryStatus;
        }>(
          'SELECT provider_message_id,channel,recipient,body,status FROM messages WHERE id=$1',
          [job.message_id],
        )
      ).rows[0];
      await providerLock(c, message.provider_message_id);
      const current = (
        await c.query<{ status: DeliveryStatus }>(
          'SELECT status FROM messages WHERE id=$1 FOR UPDATE',
          [job.message_id],
        )
      ).rows[0];
      if (current.status !== 'queued') {
        await c.query("UPDATE send_jobs SET state='done' WHERE message_id=$1", [
          job.message_id,
        ]);
        return true;
      }
      const attempt = job.attempts + 1;
      let success = false;
      try {
        await this.channels.get(message.channel).send({
          providerMessageId: message.provider_message_id,
          to: message.recipient,
          body: message.body,
        });
        success = true;
      } catch {
        // A provider failure is retryable. Database failures below must roll back.
      }
      if (success || attempt >= 3) {
        await applyStatus(
          c,
          message.provider_message_id,
          success ? 'sent' : 'failed',
          new Date().toISOString(),
        );
        await c.query(
          "UPDATE send_jobs SET attempts=$2,state='done' WHERE message_id=$1",
          [job.message_id, attempt],
        );
      } else {
        const base = Number(process.env.RETRY_BASE_MS ?? 1000);
        if (!Number.isFinite(base) || base < 1 || base > 60000)
          throw new Error('RETRY_BASE_MS must be between 1 and 60000');
        await c.query(
          "UPDATE send_jobs SET attempts=$2,next_attempt_at=clock_timestamp()+($3::double precision*interval '1 millisecond') WHERE message_id=$1",
          [job.message_id, attempt, base * 2 ** (attempt - 1)],
        );
      }
      return true;
    });
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
