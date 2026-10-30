import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('inbox_events')
export class InboxEvent {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column({ name: 'location_id', type: 'integer' })
  locationId: number;

  @Column('text')
  type: string;

  @Column('jsonb')
  payload: unknown;
}
