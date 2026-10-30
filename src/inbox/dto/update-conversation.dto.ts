import { IsIn, ValidateIf } from 'class-validator';
import { NonBlankString } from '../../common/validation.decorators';

export class UpdateConversationDto {
  // Require status when neither field is supplied, rejecting an empty patch.
  @ValidateIf(
    (dto: UpdateConversationDto) =>
      dto.status !== undefined || dto.assignedTo === undefined,
  )
  @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

  // Explicit null unassigns an agent; omitted fields must preserve assignment.
  @ValidateIf(
    (_: UpdateConversationDto, value: unknown) =>
      value !== undefined && value !== null,
  )
  @NonBlankString()
  assignedTo?: string | null;
}
