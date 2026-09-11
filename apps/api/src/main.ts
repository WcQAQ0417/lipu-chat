import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.enableCors({ origin: config.webOrigin.split(',').map(value => value.trim()), credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  console.log(`Lipu API listening on http://localhost:${config.port}`);
}

bootstrap().catch(error => { console.error(error); process.exit(1); });
