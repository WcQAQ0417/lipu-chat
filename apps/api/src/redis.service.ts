import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { config } from './config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  client: RedisClientType = createClient({ url: config.redisUrl, password: config.redisPassword });

  async onModuleInit() {
    this.client.on('error', error => console.error('Redis error', error.message));
    await this.client.connect();
  }

  async onModuleDestroy() { if (this.client.isOpen) await this.client.quit(); }
}

