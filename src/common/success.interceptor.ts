import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

@Injectable()
export class SuccessInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((data: unknown) => {
        if (
          response.headersSent ||
          response.statusCode === 204 ||
          response.statusCode === 304 ||
          data instanceof StreamableFile
        )
          return data;
        const result =
          typeof data === 'object' &&
          data !== null &&
          'message' in data &&
          typeof data.message === 'string' &&
          'data' in data
            ? data
            : undefined;
        return {
          status: response.statusCode,
          message: result?.message ?? 'Success',
          data: result ? result.data : (data ?? null),
        };
      }),
    );
  }
}
