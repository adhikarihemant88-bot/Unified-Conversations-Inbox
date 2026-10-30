import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  if (existsSync('.env.local')) loadEnvFile('.env.local');
  if (existsSync('.env')) loadEnvFile('.env');
  for (const name of ['INBOX_TOKEN', 'WEBHOOK_TOKEN', 'ADMIN_TOKEN'])
    if (!process.env[name]) throw new Error(`${name} is required`);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
