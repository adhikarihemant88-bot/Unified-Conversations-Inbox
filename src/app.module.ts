import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { SuccessInterceptor } from './common/success.interceptor';
import { Module, ValidationPipe } from '@nestjs/common';
import { DatabaseService } from './utils/database.service';
import { Channels } from './inbox/channels';
import { AgentGuard } from './inbox/auth';
import { WebhookGuard } from './webhook/webhook.guard';
import { WebhookService } from './webhook/webhook.service';
import { WebhookController } from './webhook/webhook.controller';
import { InboxService } from './inbox/inbox.service';
import { EventsService } from './inbox/events.service';
import { SendWorker } from './inbox/send.worker';
import { InboxController } from './inbox/inbox.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [],
  controllers: [HealthController, InboxController, WebhookController],
  providers: [
    DatabaseService,
    Channels,
    AgentGuard,
    WebhookGuard,
    InboxService,
    WebhookService,
    EventsService,
    SendWorker,
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
          transformOptions: { enableImplicitConversion: false },
          validationError: { target: false, value: false },
        }),
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: SuccessInterceptor },
  ],
})
export class AppModule {}
