import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { BearerAuthGuard } from './common/bearer-auth';
import { SuccessInterceptor } from './common/success.interceptor';
import { Module, ValidationPipe } from '@nestjs/common';
import { DatabaseService } from './utils/database.service';
import { Channels } from './inbox/channels';
import { WebhookService } from './webhook/webhook.service';
import { WebhookController } from './webhook/webhook.controller';
import { InboxService } from './inbox/inbox.service';
import { EventsService } from './inbox/events.service';
import { SendWorker } from './inbox/send.worker';
import { InboxController } from './inbox/inbox.controller';
import { AgentsController } from './admin/agents.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [],
  controllers: [
    HealthController,
    InboxController,
    AgentsController,
    WebhookController,
  ],
  providers: [
    DatabaseService,
    Channels,
    BearerAuthGuard,
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
