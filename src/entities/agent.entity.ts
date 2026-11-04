import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column({ name: 'location_id', type: 'integer' })
  locationId: number;

  @Column('text')
  name: string;

  @Column({ name: 'last_assigned_at', type: 'timestamptz', nullable: true })
  lastAssignedAt: Date | null;
}
