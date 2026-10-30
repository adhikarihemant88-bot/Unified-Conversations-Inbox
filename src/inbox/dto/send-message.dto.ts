import { IsIn } from 'class-validator';
import type { Channel } from '../domain';
import { NonBlankString } from '../../common/validation.decorators';

export class SendMessageDto {
  @IsIn(['sms', 'whatsapp', 'email'])
  channel: Channel;

  @NonBlankString()
  body: string;
}
