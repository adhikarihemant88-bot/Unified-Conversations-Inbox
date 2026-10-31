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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { BearerAuthGuard, UseBearerToken } from '../common/bearer-auth';
import { LocationScopeGuard } from '../common/location-scope.guard';
import { TypingDto } from './dto/typing.dto';
import { EventsQueryDto } from './dto/events-query.dto';
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
@UseBearerToken('INBOX_TOKEN')
@UseGuards(BearerAuthGuard, LocationScopeGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly events: EventsService,
  ) {}
  @Get('locations/:locationId/conversations')
  async conversations(
    @Param() params: LocationParamsDto,
    @Query() query: ConversationQueryDto,
  ) {
    const { items, nextCursor, hasMore } = await this.inbox.listConversations(
      params.locationId,
      query,
    );
    return { message: 'Success', data: items, nextCursor, hasMore };
  }

  @Get('conversations/:id/messages')
  messages(
    @Param() params: ConversationParamsDto,
    @Query() query: PaginationDto,
  ) {
    return this.inbox.listMessages(params.id, query);
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
  send(@Param() params: ConversationParamsDto, @Body() body: SendMessageDto) {
    return this.inbox.send(params.id, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  read(@Param() params: ConversationParamsDto) {
    return this.inbox.read(params.id);
  }

  @Patch('conversations/:id')
  patch(
    @Param() params: ConversationParamsDto,
    @Body() body: UpdateConversationDto,
  ) {
    return this.inbox.patch(params.id, body);
  }

  @Get('locations/:locationId/events')
  async eventsStream(
    @Param() params: LocationParamsDto,
    @Query() query: EventsQueryDto,
    @Headers('last-event-id') last: unknown,
    @Res() res: Response,
  ) {
    const locationId = await this.inbox.resolveLocationId(params.locationId);
    return this.events.open(locationId, last, res, query.agentId);
  }

  @Post('locations/:locationId/typing')
  @HttpCode(202)
  typing(@Param() params: LocationParamsDto, @Body() body: TypingDto) {
    return this.inbox.typing(params.locationId, body);
  }

  @Get('locations/:locationId/presence')
  presence(@Param() params: LocationParamsDto) {
    return this.inbox.presence(params.locationId);
  }
}
