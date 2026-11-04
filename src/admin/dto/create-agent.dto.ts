import { NonBlankString } from '../../common/validation.decorators';

export class CreateAgentDto {
  @NonBlankString()
  name: string;

  // Location name, as used in webhook payloads and routes (for example loc_1).
  @NonBlankString()
  locationId: string;
}
