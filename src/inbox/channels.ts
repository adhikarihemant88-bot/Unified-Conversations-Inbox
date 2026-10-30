import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type Channel, text } from './domain';

export interface ChannelAdapter {
  kind: 'phone' | 'email';
  normalize(value: unknown): string;
  send(message: {
    providerMessageId: string;
    to: string;
    body: string;
  }): Promise<void>;
}
function phone(value: unknown): string {
  const raw = text(value, 'phone')
    .replace(/^whatsapp:/i, '')
    .trim();
  if (!/^\+[\d\s().-]+$/.test(raw))
    throw new BadRequestException('Phone must include + and country code');
  const normalized = raw.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized))
    throw new BadRequestException('Invalid international phone number');
  return normalized;
}
function email(value: unknown): string {
  const normalized = text(value, 'email').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw new BadRequestException('Invalid email address');
  return normalized;
}

@Injectable()
export class Channels {
  private readonly adapters: Record<Channel, ChannelAdapter>;
  constructor() {
    const rate = Number(process.env.MOCK_FAILURE_RATE ?? 0.2);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1)
      throw new Error('MOCK_FAILURE_RATE must be between 0 and 1');
    const send = async () => {
      await Promise.resolve();
      if (Math.random() < rate)
        throw new Error('Mock provider temporarily unavailable');
    };
    this.adapters = {
      sms: { kind: 'phone', normalize: phone, send },
      whatsapp: { kind: 'phone', normalize: phone, send },
      email: { kind: 'email', normalize: email, send },
    };
  }
  get(channel: Channel): ChannelAdapter {
    return this.adapters[channel];
  }
  allocateId(): string {
    return `mock_${randomUUID()}`;
  }
}
