import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { DeliveryStatus } from '../inbox/domain';

@Entity('provider_states')
export class ProviderState {
  @PrimaryColumn({ name: 'provider_message_id', type: 'text' })
  providerMessageId: string;

  @Column('text')
  status: DeliveryStatus;

  @Column({ name: 'event_at', type: 'timestamptz' })
  eventAt: Date;
}
