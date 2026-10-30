import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { DatabaseService } from '../utils/database.service';

export type Agent = { id: string; location_id: string };
export type AgentRequest = Request & { agent: Agent };
@Injectable()
export class AgentGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AgentRequest>();
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) {
      throw new UnauthorizedException('Bearer token required');
    }
    const [agent] = await this.db.query<Agent>(
      'SELECT id, location_id FROM agents WHERE token_hash=$1',
      [createHash('sha256').update(token).digest('hex')],
    );
    if (!agent) throw new UnauthorizedException('Invalid token');
    if (req.params.locationId && req.params.locationId !== agent.location_id)
      throw new ForbiddenException('Location access denied');
    req.agent = agent;
    return true;
  }
}
