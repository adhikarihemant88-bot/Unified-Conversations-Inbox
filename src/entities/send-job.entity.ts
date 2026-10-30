import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('send_jobs')
export class SendJob {
  @PrimaryColumn({ name: 'message_id', type: 'integer' })
  messageId: number;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'text', default: 'pending' })
  state: 'pending' | 'done';

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt: Date;
}
