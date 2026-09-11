import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RoomService } from './room.service';

@Injectable()
export class LifecycleService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly rooms: RoomService) {}
  onModuleInit() {
    this.timer = setInterval(() => this.rooms.destroyDueRooms().catch(console.error), 5000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}

