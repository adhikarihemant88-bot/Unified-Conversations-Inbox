"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const core_1 = require("@nestjs/core");
const http_exception_filter_1 = require("./common/http-exception.filter");
const success_interceptor_1 = require("./common/success.interceptor");
const common_1 = require("@nestjs/common");
const database_service_1 = require("./utils/database.service");
const channels_1 = require("./inbox/channels");
const auth_1 = require("./inbox/auth");
const webhook_guard_1 = require("./webhook/webhook.guard");
const webhook_service_1 = require("./webhook/webhook.service");
const webhook_controller_1 = require("./webhook/webhook.controller");
const inbox_service_1 = require("./inbox/inbox.service");
const events_service_1 = require("./inbox/events.service");
const send_worker_1 = require("./inbox/send.worker");
const inbox_controller_1 = require("./inbox/inbox.controller");
const health_controller_1 = require("./health.controller");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [],
        controllers: [health_controller_1.HealthController, inbox_controller_1.InboxController, webhook_controller_1.WebhookController],
        providers: [
            database_service_1.DatabaseService,
            channels_1.Channels,
            auth_1.AgentGuard,
            webhook_guard_1.WebhookGuard,
            inbox_service_1.InboxService,
            webhook_service_1.WebhookService,
            events_service_1.EventsService,
            send_worker_1.SendWorker,
            {
                provide: core_1.APP_PIPE,
                useFactory: () => new common_1.ValidationPipe({
                    transform: true,
                    whitelist: true,
                    forbidNonWhitelisted: true,
                    forbidUnknownValues: true,
                    transformOptions: { enableImplicitConversion: false },
                    validationError: { target: false, value: false },
                }),
            },
            { provide: core_1.APP_FILTER, useClass: http_exception_filter_1.HttpExceptionFilter },
            { provide: core_1.APP_INTERCEPTOR, useClass: success_interceptor_1.SuccessInterceptor },
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map