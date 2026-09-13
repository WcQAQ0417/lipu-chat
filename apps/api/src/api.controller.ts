import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PersonaService } from './persona.service';
import { RoomService } from './room.service';

@Controller('api')
export class ApiController {
  constructor(
    private readonly auth: AuthService,
    private readonly personas: PersonaService,
    private readonly rooms: RoomService,
  ) {}

  private user(header?: string) { return this.auth.verify(header); }

  @Get('health') health() { return { ok: true, service: 'lipu-api', time: new Date().toISOString() }; }

  @Post('session') session(@Body() body: { nickname?: string }) { return this.auth.createAnonymous(body.nickname); }

  @Get('personas') listPersonas(@Query('enabled') enabled?: string) { return this.personas.list(enabled === 'true'); }

  @Post('personas') createPersona(@Headers('authorization') token: string, @Body() body: unknown) {
    return this.personas.create(this.user(token).uid, body);
  }

  @Patch('personas/:id') updatePersona(@Headers('authorization') token: string, @Param('id') id: string, @Body() body: unknown) {
    return this.personas.update(id, this.user(token).uid, body);
  }

  @Post('personas/:id/enable') enablePersona(@Headers('authorization') token: string, @Param('id') id: string) {
    return this.personas.setEnabled(id, this.user(token).uid, true);
  }

  @Post('personas/:id/disable') disablePersona(@Headers('authorization') token: string, @Param('id') id: string) {
    return this.personas.setEnabled(id, this.user(token).uid, false);
  }

  @Delete('personas/:id') removePersona(@Headers('authorization') token: string, @Param('id') id: string) {
    return this.personas.remove(id, this.user(token).uid);
  }

  @Get('rooms') listRooms() { return this.rooms.list(); }

  @Get('rooms/:code') room(@Param('code') code: string) { return this.rooms.find(code); }

  @Post('rooms') createRoom(@Headers('authorization') token: string, @Body() body: { name?: string; type?: string }) {
    return this.rooms.create(this.user(token).uid, body);
  }
}

