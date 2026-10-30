import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Channel, DeliveryStatus } from '../inbox/domain';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column({ name: 'location_id', type: 'integer' })
  locationId: number;

  @Column({ name: 'conversation_id', type: 'integer' })
  conversationId: number;

  @Column({ name: 'provider_message_id', type: 'text', unique: true })
  providerMessageId: string;

  @Column('text')
  channel: Channel;

  @Column('text')
  direction: 'inbound' | 'outbound';

  @Column({ name: 'sender', type: 'text' })
  from: string;

  @Column({ name: 'recipient', type: 'text' })
  to: string;

  @Column('text')
  body: string;

  @Column('text')
  status: DeliveryStatus;

  @Column({ name: 'sent_at', type: 'timestamptz' })
  sentAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
