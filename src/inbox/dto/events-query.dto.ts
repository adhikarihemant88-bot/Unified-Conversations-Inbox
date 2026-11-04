import { Transform } from 'class-transformer';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';

export class EventsQueryDto {
  // Identifies the connected agent so the stream can report its presence.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @ValidateIf((_: EventsQueryDto, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  agentId?: number;
}
