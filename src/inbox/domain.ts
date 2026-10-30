import { BadRequestException } from '@nestjs/common';

export type Channel = 'sms' | 'whatsapp' | 'email';
export type DeliveryStatus =
  'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export const ranks: Record<DeliveryStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};
export function advance(
  current: DeliveryStatus,
  incoming: DeliveryStatus,
): DeliveryStatus {
  return ranks[incoming] > ranks[current] ? incoming : current;
}
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} must be a non-empty string`);
  return value;
}
export function timestamp(value: unknown, name: string): string {
  const raw = text(value, name);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      raw,
    );
  if (!match)
    throw new BadRequestException(
      `${name} must be an ISO timestamp with timezone`,
    );
  const [, y, mo, d, h, mi, s, zone] = match;
  const year = +y;
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  // Date.parse alone silently normalizes February 30 and 24:00 to another day.
  if (
    +mo < 1 ||
    +mo > 12 ||
    +d < 1 ||
    +d > days[+mo - 1] ||
    +h > 23 ||
    +mi > 59 ||
    +s > 59 ||
    (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) ||
    !Number.isFinite(Date.parse(raw))
  ) {
    throw new BadRequestException(
      `${name} contains an invalid calendar date or time`,
    );
  }
  return new Date(raw).toISOString();
}
