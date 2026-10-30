import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type EntityManager, type EntityTarget, type ObjectLiteral, type Repository } from 'typeorm';
type TransactionIsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
export declare class DatabaseService implements OnModuleInit, OnModuleDestroy {
    private readonly source;
    constructor();
    onModuleInit(): Promise<void>;
    ormTransaction<T>(work: (manager: EntityManager) => Promise<T>, isolationLevel?: TransactionIsolationLevel): Promise<T>;
    getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity>;
    onModuleDestroy(): Promise<void>;
}
export {};
