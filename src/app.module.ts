import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { SuccessInterceptor } from './common/success.interceptor';
import { Module } from '@nestjs/common';
import { DatabaseService } from './utils/database.service';

@Module({
  imports: [],
  controllers: [],
  providers: [
    DatabaseService,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: SuccessInterceptor },
  ],
})
export class AppModule {}
