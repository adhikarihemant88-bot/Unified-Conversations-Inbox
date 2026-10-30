import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, ValidateBy } from 'class-validator';
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

export function IsSnapshotCursor() {
  return ValidateBy({
    name: 'isSnapshotCursor',
    validator: {
      validate(value: unknown) {
        if (typeof value !== 'string') return false;
        const match = /^(\d+):(\d+)$/.exec(value);
        return (
          match !== null &&
          Number.isSafeInteger(Number(match[1])) &&
          Number(match[1]) <= 2147483647 &&
          Number.isSafeInteger(Number(match[2]))
        );
      },
      defaultMessage: () => '$property must be a valid snapshot cursor',
    },
  });
}
