import { Entity, PrimaryColumn } from 'typeorm';

@Entity('agent_assignment_lock')
export class AgentAssignmentLock {
  @PrimaryColumn({ type: 'integer' })
  id: number;
}
