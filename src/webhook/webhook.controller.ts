import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { BearerAuthGuard, UseBearerToken } from '../common/bearer-auth';
import { InboundWebhookDto } from './dto/inbound-webhook.dto';
import { StatusWebhookDto } from './dto/status-webhook.dto';
import { WebhookService } from './webhook.service';

@Controller('webhooks')
@UseBearerToken('WEBHOOK_TOKEN')
@UseGuards(BearerAuthGuard)
export class WebhookController {
  constructor(private readonly webhook: WebhookService) {}
  @Post('inbound')
  @HttpCode(200)
  inbound(@Body() body: InboundWebhookDto) {
    return this.webhook.inbound(body);
  }
  @Post('status')
  @HttpCode(200)
  status(@Body() body: StatusWebhookDto) {
    return this.webhook.status(body);
  }
}
