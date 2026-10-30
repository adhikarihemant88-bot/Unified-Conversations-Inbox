import { NonBlankString } from '../../common/validation.decorators';

export class CreateAgentDto {
  @NonBlankString()
  name: string;
}
