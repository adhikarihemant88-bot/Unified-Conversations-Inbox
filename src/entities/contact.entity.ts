import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('contacts')
export class Contact {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column({ name: 'location_id', type: 'integer' })
  locationId: number;

  @Column({ type: 'text', nullable: true })
  name: string | null;
}
