import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const detail: unknown =
        typeof body === 'string'
          ? body
          : (body as { message?: unknown }).message;
      message =
        typeof detail === 'string' ||
        (Array.isArray(detail) &&
          detail.every((item: unknown) => typeof item === 'string'))
          ? (detail as string | string[])
          : exception.message;
    }
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : 'Unhandled exception',
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    if (response.headersSent) return;
    response.status(status).json({
      status,
      message,
      data: null
    });
  }
}
