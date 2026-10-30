import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is required. Set the PostgreSQL connection string in .env before starting the server.',
      );
    }
    this.pool = new Pool({
      connectionString,
    });
  }

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
