import { IsIn } from 'class-validator';
import type { Channel } from '../../inbox/domain';
import {
  IsStrictTimestamp,
  NonBlankString,
} from '../../common/validation.decorators';

export class InboundWebhookDto {
  @NonBlankString()
  providerMessageId: string;

  @NonBlankString()
  locationId: string;

  @IsIn(['sms', 'whatsapp', 'email'])
  channel: Channel;

  @NonBlankString()
  from: string;

  @NonBlankString()
  to: string;

  @NonBlankString()
  body: string;

  @IsStrictTimestamp()
  sentAt: string;
}
