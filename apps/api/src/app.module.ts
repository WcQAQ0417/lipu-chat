import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { AuthService } from './auth.service';
import { ChatGateway } from './chat.gateway';
import { DbService } from './db.service';
import { GameService } from './game.service';
import { LifecycleService } from './lifecycle.service';
import { LlmService } from './llm.service';
import { PersonaService } from './persona.service';
import { RedisService } from './redis.service';
import { RoomService } from './room.service';
import { SeedService } from './seed.service';

@Module({
  controllers: [ApiController],
  providers: [DbService, RedisService, AuthService, PersonaService, RoomService, LlmService, GameService, ChatGateway, LifecycleService, SeedService],
})
export class AppModule {}

