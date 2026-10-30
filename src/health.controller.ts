import { Controller, Get } from '@nestjs/common';
import { Location } from './entities/location.entity';
import { DatabaseService } from './utils/database.service';
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}
  @Get()
  async health() {
    await this.db.ormTransaction((manager) =>
      manager.getRepository(Location).count(),
    );
    return { healthy: true };
  }
}
