import { IsUUID } from 'class-validator';
import { NonBlankString } from '../../common/validation.decorators';

export class ConversationParamsDto {
  @IsUUID('all')
  id: string;
}

export class LocationParamsDto {
  @NonBlankString()
  locationId: string;
}
