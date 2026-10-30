import { IsIn } from 'class-validator';
import type { DeliveryStatus } from '../../inbox/domain';
import {
  IsStrictTimestamp,
  NonBlankString,
} from '../../common/validation.decorators';

export class StatusWebhookDto {
  @NonBlankString()
  providerMessageId: string;

  @IsIn(['queued', 'sent', 'delivered', 'read', 'failed'])
  status: DeliveryStatus;

  @IsStrictTimestamp()
  timestamp: string;
}
