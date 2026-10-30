import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { LessThan } from 'typeorm';
import { DatabaseService } from '../utils/database.service';
import { Channels } from './channels';
import { PaginationSnapshot } from '../entities/pagination-snapshot.entity';
import { SendJob } from '../entities/send-job.entity';
import { Message } from '../entities/message.entity';
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
      await this.db.ormTransaction((manager) =>
        manager.getRepository(PaginationSnapshot).delete({
          expiresAt: LessThan(new Date()),
        }),
      );
  }
  async processOne(): Promise<boolean> {
    return this.db.ormTransaction(async (manager) => {
      const jobs = manager.getRepository(SendJob);
      const job = await jobs
        .createQueryBuilder('job')
        .where('job.state = :state', { state: 'pending' })
        .andWhere('job.nextAttemptAt <= :now', { now: new Date() })
        .orderBy('job.nextAttemptAt', 'ASC')
        .addOrderBy('job.messageId', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!job) return false;
      const messages = manager.getRepository(Message);
      const message = await messages.findOneByOrFail({
        id: job.messageId,
      });
      await providerLock(manager, message.providerMessageId);
      const current = await messages.findOne({
        where: { id: job.messageId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new Error(`Message ${job.messageId} disappeared`);
      if (current.status !== 'queued') {
        job.state = 'done';
        await jobs.save(job);
        return true;
      }
      const attempt = job.attempts + 1;
      let success = false;
      try {
        await this.channels.get(message.channel).send({
          providerMessageId: message.providerMessageId,
          to: message.to,
          body: message.body,
        });
        success = true;
      } catch {
        // A provider failure is retryable. Database failures below must roll back.
      }
      if (success || attempt >= 3) {
        await applyStatus(
          manager,
          message.providerMessageId,
          success ? 'sent' : 'failed',
          new Date(),
        );
        job.attempts = attempt;
        job.state = 'done';
        await jobs.save(job);
      } else {
        const base = Number(process.env.RETRY_BASE_MS ?? 1000);
        if (!Number.isFinite(base) || base < 1 || base > 60000)
          throw new Error('RETRY_BASE_MS must be between 1 and 60000');
        job.attempts = attempt;
        job.nextAttemptAt = new Date(Date.now() + base * 2 ** (attempt - 1));
        await jobs.save(job);
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
