import { OnModuleDestroy } from '@nestjs/common';
export declare class DatabaseService implements OnModuleDestroy {
    private readonly pool;
    constructor();
    query<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
    onModuleDestroy(): Promise<void>;
}
