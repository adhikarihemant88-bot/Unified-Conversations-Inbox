import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('contact_identities')
export class ContactIdentity {
  @PrimaryColumn({ name: 'location_id', type: 'integer' })
  locationId: number;

  @PrimaryColumn('text')
  kind: 'phone' | 'email';

  @PrimaryColumn('text')
  value: string;

  @Column({ name: 'contact_id', type: 'integer' })
  contactId: number;
}
