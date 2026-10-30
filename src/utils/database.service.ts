import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DataSource,
  type EntityManager,
  type EntityTarget,
  type ObjectLiteral,
  type Repository,
} from 'typeorm';
import { AgentAssignmentLock } from '../entities/agent-assignment-lock.entity';
import { Agent } from '../entities/agent.entity';
import { Contact } from '../entities/contact.entity';
import { ContactIdentity } from '../entities/contact-identity.entity';
import { Conversation } from '../entities/conversation.entity';
import { InboxEvent } from '../entities/inbox-event.entity';
import { Location } from '../entities/location.entity';
import { Message } from '../entities/message.entity';
import { PaginationSnapshot } from '../entities/pagination-snapshot.entity';
import { ProviderState } from '../entities/provider-state.entity';
import { SendJob } from '../entities/send-job.entity';
import { databaseUrl } from './database-url';

type TransactionIsolationLevel =
  'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly source: DataSource;

  constructor() {
    this.source = new DataSource({
      type: 'postgres',
      url: databaseUrl(process.env.DATABASE_URL),
      entities: [
        Agent,
        AgentAssignmentLock,
        Contact,
        ContactIdentity,
        Conversation,
        InboxEvent,
        Location,
        Message,
        PaginationSnapshot,
        ProviderState,
        SendJob,
      ],
      synchronize: false,
      installExtensions: false,
    });
  }

  async onModuleInit() {
    await this.source.initialize();
  }

  ormTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
    isolationLevel?: TransactionIsolationLevel,
  ): Promise<T> {
    return isolationLevel
      ? this.source.transaction(isolationLevel, work)
      : this.source.transaction(work);
  }

  getRepository<Entity extends ObjectLiteral>(
    target: EntityTarget<Entity>,
  ): Repository<Entity> {
    return this.source.getRepository(target);
  }

  async onModuleDestroy() {
    if (this.source.isInitialized) await this.source.destroy();
  }
}
