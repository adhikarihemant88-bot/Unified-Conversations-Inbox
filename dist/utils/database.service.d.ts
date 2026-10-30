import { OnModuleDestroy } from '@nestjs/common';
import { type PoolClient } from 'pg';
export declare class DatabaseService implements OnModuleDestroy {
    private readonly pool;
    constructor();
    query<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
    transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
    onModuleDestroy(): Promise<void>;
}
