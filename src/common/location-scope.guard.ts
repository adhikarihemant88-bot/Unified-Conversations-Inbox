import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { Conversation } from '../entities/conversation.entity';
import { Location } from '../entities/location.entity';
import { DatabaseService } from '../utils/database.service';

/**
 * Restricts location-scoped inbox tokens to their own location. Runs after
 * BearerAuthGuard; callers using the shared INBOX_TOKEN are not restricted.
 */
@Injectable()
export class LocationScopeGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const scope = request.locationScope;
    if (scope === undefined) return true;

    const { locationId, id } = request.params as Record<string, unknown>;
    if (typeof locationId === 'string') {
      if (locationId !== scope) throw new ForbiddenException('Wrong location');
      return true;
    }
    // Malformed IDs fall through so validation reports them as HTTP 400.
    if (
      typeof id === 'string' &&
      /^\d{1,10}$/.test(id) &&
      Number(id) <= 2147483647
    ) {
      const conversation = await this.db
        .getRepository(Conversation)
        .findOneBy({ id: Number(id) });
      if (!conversation) return true; // The handler responds 404.
      const location = await this.db
        .getRepository(Location)
        .findOneBy({ id: conversation.locationId });
      if (location?.name !== scope)
        throw new ForbiddenException('Wrong location');
      return true;
    }
    return true;
  }
}
