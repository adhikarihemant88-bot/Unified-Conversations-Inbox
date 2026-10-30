import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { NonBlankString } from '../../common/validation.decorators';

export class ConversationParamsDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id: number;
}

export class LocationParamsDto {
  @NonBlankString()
  locationId: string;
}
