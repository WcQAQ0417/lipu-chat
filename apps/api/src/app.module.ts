import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { AuthService } from './auth.service';
import { ChatGateway } from './chat.gateway';
import { DbService } from './db.service';
import { EffectsController } from './effects.controller';
import { GameService } from './game.service';
import { LifecycleService } from './lifecycle.service';
import { LlmService } from './llm.service';
import { PersonaService } from './persona.service';
import { RedisService } from './redis.service';
import { RoomService } from './room.service';
import { SeedService } from './seed.service';
import { TokendanceService } from './tokendance.service';

@Module({
  controllers: [ApiController, EffectsController],
  providers: [DbService, RedisService, AuthService, PersonaService, RoomService, LlmService, GameService, ChatGateway, LifecycleService, SeedService, TokendanceService],
})
export class AppModule {}

