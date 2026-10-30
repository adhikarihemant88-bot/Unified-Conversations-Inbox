import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AgentGuard, type AgentRequest } from './auth';
import { InboxService } from './inbox.service';
import { EventsService } from './events.service';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import {
  ConversationQueryDto,
  PaginationDto,
  SearchMessagesDto,
} from './dto/pagination.dto';
import {
  ConversationParamsDto,
  LocationParamsDto,
} from './dto/route-params.dto';
@Controller()
@UseGuards(AgentGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly events: EventsService,
  ) {}
  @Get('locations/:locationId/conversations')
  conversations(
    @Param() params: LocationParamsDto,
    @Query() query: ConversationQueryDto,
  ) {
    return this.inbox.listConversations(params.locationId, query);
  }

  @Get('conversations/:id/messages')
  messages(
    @Req() req: AgentRequest,
    @Param() params: ConversationParamsDto,
    @Query() query: PaginationDto,
  ) {
    return this.inbox.listMessages(req.agent.location_id, params.id, query);
  }

  @Get('locations/:locationId/messages/search')
  search(
    @Param() params: LocationParamsDto,
    @Query() query: SearchMessagesDto,
  ) {
    return this.inbox.search(params.locationId, query);
  }

  @Post('conversations/:id/messages')
  @HttpCode(202)
  send(
    @Req() req: AgentRequest,
    @Param() params: ConversationParamsDto,
    @Body() body: SendMessageDto,
  ) {
    return this.inbox.send(req.agent.location_id, params.id, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  read(@Req() req: AgentRequest, @Param() params: ConversationParamsDto) {
    return this.inbox.read(req.agent.location_id, params.id);
  }

  @Patch('conversations/:id')
  patch(
    @Req() req: AgentRequest,
    @Param() params: ConversationParamsDto,
    @Body() body: UpdateConversationDto,
  ) {
    return this.inbox.patch(req.agent.location_id, params.id, body);
  }

  @Get('locations/:locationId/events')
  eventsStream(
    @Param() params: LocationParamsDto,
    @Headers('last-event-id') last: unknown,
    @Res() res: Response,
  ) {
    return this.events.open(params.locationId, last, res);
  }
}
