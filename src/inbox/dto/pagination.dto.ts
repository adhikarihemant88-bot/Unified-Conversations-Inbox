import { Transform } from 'class-transformer';
import { IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
import {
  IsSnapshotCursor,
  NonBlankString,
} from '../../common/validation.decorators';

export class PaginationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @ValidateIf((_: PaginationDto, value: unknown) => value !== undefined)
  @IsSnapshotCursor()
  cursor?: string;
}

export class ConversationQueryDto extends PaginationDto {
  @ValidateIf((_: ConversationQueryDto, value: unknown) => value !== undefined)
  @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

  @ValidateIf((_: ConversationQueryDto, value: unknown) => value !== undefined)
  @NonBlankString()
  assignedTo?: string;
}

export class SearchMessagesDto extends PaginationDto {
  @NonBlankString()
  q: string;
}
