import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, ValidateBy } from 'class-validator';
import { decodeCursor } from '../inbox/cursor';
import { timestamp } from '../inbox/domain';

export function NonBlankString() {
  return applyDecorators(
    IsString(),
    Matches(/\S/, {
      message: '$property must contain non-whitespace characters',
    }),
  );
}

export function IsStrictTimestamp() {
  return ValidateBy({
    name: 'isStrictTimestamp',
    validator: {
      validate(value: unknown) {
        try {
          timestamp(value, 'timestamp');
          return true;
        } catch {
          return false;
        }
      },
      defaultMessage: () =>
        '$property must be a valid ISO calendar timestamp with timezone',
    },
  });
}

export function IsKeysetCursor() {
  return ValidateBy({
    name: 'isKeysetCursor',
    validator: {
      validate: (value: unknown) => decodeCursor(value) !== null,
      defaultMessage: () => '$property must be a valid pagination cursor',
    },
  });
}
