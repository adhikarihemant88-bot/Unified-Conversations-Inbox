import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

@Injectable()
export class WebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.WEBHOOK_TOKEN;
    const supplied = context.switchToHttp().getRequest<Request>().headers[
      'x-webhook-token'
    ];
    if (!expected)
      throw new UnauthorizedException(
        'Webhook authentication is not configured',
      );
    if (typeof supplied !== 'string')
      throw new UnauthorizedException('Invalid webhook token');
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(hash(expected), hash(supplied)))
      throw new UnauthorizedException('Invalid webhook token');
    return true;
  }
}
