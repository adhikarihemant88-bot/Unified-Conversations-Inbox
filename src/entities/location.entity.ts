import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('locations')
export class Location {
  @PrimaryGeneratedColumn('identity', { type: 'integer' })
  id: number;

  @Column({ type: 'text', unique: true })
  name: string;
}
