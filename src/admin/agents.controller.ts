import {
  Body,
  ConflictException,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Agent } from '../entities/agent.entity';
import { DatabaseService } from '../utils/database.service';
import { BearerAuthGuard, UseBearerToken } from '../common/bearer-auth';
import { CreateAgentDto } from './dto/create-agent.dto';

@Controller('admin/agents')
@UseBearerToken('ADMIN_TOKEN')
@UseGuards(BearerAuthGuard)
export class AgentsController {
  constructor(private readonly db: DatabaseService) {}

  @Post()
  async create(@Body() body: CreateAgentDto) {
    return this.db.ormTransaction(async (manager) => {
      const agents = manager.getRepository(Agent);
      const name = body.name.trim();
      const existing = await agents
        .createQueryBuilder('agent')
        .where('LOWER(BTRIM(agent.name)) = LOWER(BTRIM(:name))', { name })
        .getOne();
      if (existing) throw new ConflictException('Agent already exists');

      const result = await agents
        .createQueryBuilder()
        .insert()
        .values({ name, lastAssignedAt: new Date() })
        .orIgnore()
        .execute();
      const id = result.identifiers[0]?.id;
      if (typeof id !== 'number')
        throw new ConflictException('Agent already exists');

      const agent = await agents.findOneByOrFail({ id });
      return { id: agent.id, name: agent.name };
    });
  }
}
