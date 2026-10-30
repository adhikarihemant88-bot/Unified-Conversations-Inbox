import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('pagination_snapshots')
export class PaginationSnapshot {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column({ name: 'location_id', type: 'integer' })
  locationId: number;

  @Column('text')
  scope: string;

  @Column({ type: 'jsonb' })
  items: Record<string, unknown>[];

  @Column({
    name: 'expires_at',
    type: 'timestamptz',
    default: () => "clock_timestamp() + interval '15 minutes'",
  })
  expiresAt: Date;
}
