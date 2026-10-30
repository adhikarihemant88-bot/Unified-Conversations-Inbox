import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column('text')
  name: string;

  @Column({ name: 'last_assigned_at', type: 'timestamptz', nullable: true })
  lastAssignedAt: Date | null;
}
