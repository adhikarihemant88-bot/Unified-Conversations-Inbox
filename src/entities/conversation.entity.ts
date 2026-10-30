import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('conversations')
@Unique(['locationId', 'participantAId', 'participantBId'])
export class Conversation {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column({ name: 'location_id', type: 'integer' })
  locationId: number;

  @Column({ name: 'participant_a_id', type: 'integer' })
  participantAId: number;

  @Column({ name: 'participant_b_id', type: 'integer' })
  participantBId: number;

  @Column({ type: 'text', default: 'open' })
  status: 'open' | 'closed';

  @Column({ name: 'assigned_to', type: 'integer', nullable: true })
  assignedTo: number | null;

  @Column({ name: 'unread_count', type: 'integer', default: 0 })
  unreadCount: number;

  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt: Date | null;

  @Column({ name: 'last_message_id', type: 'integer', nullable: true })
  lastMessageId: number | null;

  @Column({ name: 'last_message_preview', type: 'text', nullable: true })
  lastMessagePreview: string | null;
}
