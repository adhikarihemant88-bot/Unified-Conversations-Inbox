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

declare module 'express-serve-static-core' {
  interface Request {
    /** Set when the caller authenticated with a location-scoped inbox token. */
    locationScope?: string;
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest();
const sameToken = (expected: string, supplied: string) =>
  timingSafeEqual(hash(expected), hash(supplied));

/**
 * `INBOX_LOCATION_TOKENS` is a comma-separated list of `location:token` pairs.
 * Each token only grants access to its own location.
 */
function locationForToken(supplied: string): string | undefined {
  let match: string | undefined;
  for (const entry of (process.env.INBOX_LOCATION_TOKENS ?? '').split(',')) {
    const separator = entry.indexOf(':');
    if (separator < 1) continue;
    const token = entry.slice(separator + 1).trim();
    // Compare every entry so timing does not reveal which one matched.
    if (token && sameToken(token, supplied))
      match = entry.slice(0, separator).trim();
  }
  return match;
}

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

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const supplied =
      typeof authorization === 'string'
        ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
        : undefined;
    const expected = process.env[environment];
    const scoped =
      environment === 'INBOX_TOKEN' && supplied
        ? locationForToken(supplied)
        : undefined;
    if (!expected && !scoped)
      throw new UnauthorizedException(`${environment} is not configured`);
    if (!supplied) throw new UnauthorizedException('Invalid bearer token');

    if (expected && sameToken(expected, supplied)) return true;
    if (scoped) {
      request.locationScope = scoped;
      return true;
    }
    throw new UnauthorizedException('Invalid bearer token');
  }
}
