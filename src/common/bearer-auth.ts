import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export type BearerTokenEnvironment =
  'INBOX_TOKEN' | 'WEBHOOK_TOKEN' | 'ADMIN_TOKEN';

const bearerTokenEnvironmentKey = Symbol('bearer-token-environment');

export const UseBearerToken = (environment: BearerTokenEnvironment) =>
  SetMetadata(bearerTokenEnvironmentKey, environment);

@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const environment =
      this.reflector.getAllAndOverride<BearerTokenEnvironment>(
        bearerTokenEnvironmentKey,
        [context.getHandler(), context.getClass()],
      );
    if (!environment)
      throw new Error('Bearer token environment is not configured');

    const expected = process.env[environment];
    if (!expected)
      throw new UnauthorizedException(`${environment} is not configured`);

    const authorization = context.switchToHttp().getRequest<Request>()
      .headers.authorization;
    const supplied =
      typeof authorization === 'string'
        ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
        : undefined;
    if (!supplied) throw new UnauthorizedException('Invalid bearer token');

    const hash = (token: string) => createHash('sha256').update(token).digest();
    if (!timingSafeEqual(hash(expected), hash(supplied)))
      throw new UnauthorizedException('Invalid bearer token');
    return true;
  }
}
