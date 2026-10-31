import { IsBoolean, IsInt, Max, Min } from 'class-validator';

export class TypingDto {
  @IsInt()
  @Min(1)
  @Max(2147483647)
  conversationId: number;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  agentId: number;

  @IsBoolean()
  typing: boolean;
}
