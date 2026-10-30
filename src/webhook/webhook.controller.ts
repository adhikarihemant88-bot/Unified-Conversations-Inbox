import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InboundWebhookDto } from './dto/inbound-webhook.dto';
import { StatusWebhookDto } from './dto/status-webhook.dto';
import { WebhookGuard } from './webhook.guard';
import { WebhookService } from './webhook.service';

@Controller('webhooks')
@UseGuards(WebhookGuard)
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
