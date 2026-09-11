import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer, WsException } from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { Server, Socket } from 'socket.io';
import { AuthService } from './auth.service';
import { DbService } from './db.service';
import { GameService } from './game.service';
import { LlmService } from './llm.service';
import type { PersonaLike } from './llm.service';
import { PersonaService } from './persona.service';
import { RedisService } from './redis.service';
import { RoomService } from './room.service';

type SocketData = { uid: number; publicId: string; nickname: string; roomId?: number; roomCode?: string; memberId?: number };

@WebSocketGateway({ cors: { origin: true, credentials: true }, transports: ['websocket'] })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly auth: AuthService,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly rooms: RoomService,
    private readonly personas: PersonaService,
    private readonly llm: LlmService,
    private readonly game: GameService,
  ) {}

  handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.headers.authorization;
      const user = this.auth.verify(token);
      (client.data as SocketData) = { uid: user.uid, publicId: user.sub, nickname: user.nickname };
    } catch { client.disconnect(true); }
  }

  async handleDisconnect(client: Socket) {
    const data = client.data as SocketData;
    if (!data.roomId || !data.memberId) return;
    await this.redis.client.sRem(`room:${data.roomId}:member:${data.memberId}:sockets`, client.id);
    const sockets = await this.redis.client.sCard(`room:${data.roomId}:member:${data.memberId}:sockets`);
    if (!sockets) await this.redis.client.sRem(`room:${data.roomId}:presence`, String(data.memberId));
    setTimeout(() => this.rooms.scheduleIfEmpty(data.roomId!).catch(error => this.logger.error(error)), 3000);
    client.to(`room:${data.roomId}`).emit('member:left', { memberId: data.memberId });
  }

  @SubscribeMessage('room:join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: { roomCode: string; personaId: string }) {
    try {
      const data = client.data as SocketData;
      const room = await this.rooms.find(body.roomCode);
      const joined = await this.rooms.join(room, data.uid, body.personaId);
      Object.assign(data, { roomId: Number(room.id), roomCode: room.room_code, memberId: joined.memberId });
      await client.join(`room:${room.id}`);
      await this.redis.client.sAdd(`room:${room.id}:presence`, String(joined.memberId));
      await this.redis.client.sAdd(`room:${room.id}:member:${joined.memberId}:sockets`, client.id);
      await this.redis.client.expire(`room:${room.id}:member:${joined.memberId}:sockets`, 600);
      const mission = room.room_type === 'THEME' ? await this.game.assignMission(Number(room.id), joined.memberId) : null;
      const chaos = await this.game.currentChaos(Number(room.id));
      const messages = await this.loadMessages(Number(room.id));
      client.to(`room:${room.id}`).emit('member:joined', { memberId: joined.memberId, nickname: data.nickname, personaName: joined.persona.name });
      return { ok: true, room: { code: room.room_code, name: room.name, type: room.room_type }, memberId: joined.memberId, mission, chaos, messages };
    } catch (error: any) { throw new WsException(error?.message || '加入房间失败'); }
  }

  @SubscribeMessage('persona:switch')
  async switchPersona(@ConnectedSocket() client: Socket, @MessageBody() body: { personaId: string }) {
    const data = this.requireRoom(client);
    const persona = await this.personas.findByPublicId(body.personaId);
    if (!persona.enabled) throw new WsException('人物未启用');
    await this.db.pool.execute('UPDATE room_members SET current_persona_id=? WHERE id=? AND user_id=?', [persona.id, data.memberId, data.uid]);
    const chaos = await this.game.addChaos(data.roomId!, 9);
    this.server.to(`room:${data.roomId}`).emit('member:persona_changed', { memberId: data.memberId, personaId: body.personaId, personaName: persona.name });
    this.broadcastChaos(data.roomId!, chaos);
    return { ok: true, personaId: body.personaId, personaName: persona.name };
  }

  @SubscribeMessage('message:transform')
  async transform(@ConnectedSocket() client: Socket, @MessageBody() body: { originalText: string; clientMessageId: string }) {
    const data = this.requireRoom(client);
    const original = String(body.originalText || '').trim();
    if (!original || original.length > 500) throw new WsException('消息长度应为 1～500 字');
    const memberRows = await this.db.rows<RowDataPacket[]>(
      `SELECT p.*,rm.id member_id FROM room_members rm JOIN personas p ON p.id=rm.current_persona_id
       WHERE rm.id=? AND rm.user_id=? AND rm.member_status='JOINED' LIMIT 1`, [data.memberId, data.uid],
    );
    if (!memberRows.length || !memberRows[0].enabled) throw new WsException('当前人物不可用，请切换人物');
    const persona = memberRows[0];
    const transformedText = await this.llm.transform(original, persona as PersonaLike);
    const draftId = randomUUID();
    await this.redis.client.set(`draft:${draftId}`, JSON.stringify({
      uid: data.uid, roomId: data.roomId, memberId: data.memberId, clientMessageId: body.clientMessageId,
      originalText: original, transformedText, personaId: persona.id, personaPublicId: persona.public_id,
      personaVersion: persona.version, personaSnapshot: this.personas.map(persona), createdAt: Date.now(),
    }), { EX: 120 });
    return { ok: true, draftId, transformedText, autoSendAfterMs: 3000, persona: { publicId: persona.public_id, name: persona.name, visual: this.parse(persona.visual_config) } };
  }

  @SubscribeMessage('message:commit')
  async commit(@ConnectedSocket() client: Socket, @MessageBody() body: { draftId: string; editedText?: string }) {
    const data = this.requireRoom(client);
    const raw = await this.redis.client.getDel(`draft:${body.draftId}`);
    if (!raw) throw new WsException('预览已过期或已经发送');
    const draft = JSON.parse(raw);
    if (draft.uid !== data.uid || draft.roomId !== data.roomId) throw new WsException('无权提交此预览');
    const text = String(body.editedText || draft.transformedText).trim().slice(0, 1500);
    const idemKey = `idem:message:${data.uid}:${draft.clientMessageId}`;
    const existing = await this.redis.client.get(idemKey);
    if (existing) return { ok: true, duplicate: true, message: JSON.parse(existing) };
    const sequenceNo = await this.redis.client.incr(`room:${data.roomId}:seq`);
    const publicId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    await this.db.pool.execute<ResultSetHeader>(
      `INSERT INTO messages(public_id,client_message_id,room_id,room_member_id,user_id,persona_id,persona_version,
       persona_snapshot,original_text,transformed_text,content_format,transform_status,sequence_no)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [publicId, draft.clientMessageId, data.roomId, data.memberId, data.uid, draft.personaId, draft.personaVersion,
       JSON.stringify(draft.personaSnapshot), draft.originalText, text, this.detectFormat(text), 'SUCCEEDED', sequenceNo],
    );
    const message = { publicId, sequenceNo, sender: { memberId: data.memberId, nickname: data.nickname }, persona: draft.personaSnapshot, text, createdAt: new Date().toISOString() };
    await this.redis.client.set(idemKey, JSON.stringify(message), { EX: 600 });
    this.server.to(`room:${data.roomId}`).emit('message:ready', message);
    const chaos = await this.game.addChaos(data.roomId!, 12 + Math.min(8, Math.floor(text.length / 40)));
    this.broadcastChaos(data.roomId!, chaos);
    return { ok: true, message };
  }

  @SubscribeMessage('message:cancel')
  async cancel(@ConnectedSocket() client: Socket, @MessageBody() body: { draftId: string }) {
    this.requireRoom(client);
    await this.redis.client.del(`draft:${body.draftId}`);
    return { ok: true };
  }

  private requireRoom(client: Socket) {
    const data = client.data as SocketData;
    if (!data.uid || !data.roomId || !data.memberId) throw new WsException('请先加入房间');
    return data;
  }

  private async loadMessages(roomId: number) {
    const rows = await this.db.rows<RowDataPacket[]>(
      `SELECT m.public_id,m.sequence_no,m.transformed_text,m.persona_snapshot,m.created_at,rm.public_id member_public_id,u.nickname
       FROM messages m JOIN room_members rm ON rm.id=m.room_member_id JOIN users u ON u.id=m.user_id
       WHERE m.room_id=? ORDER BY m.sequence_no DESC LIMIT 100`, [roomId],
    );
    return rows.reverse().map(row => ({ publicId: row.public_id, sequenceNo: Number(row.sequence_no), sender: { memberId: row.member_public_id, nickname: row.nickname }, persona: this.parse(row.persona_snapshot), text: row.transformed_text, createdAt: row.created_at }));
  }

  private broadcastChaos(roomId: number, chaos: { value: number; triggered: boolean; rule?: string; endsAt?: number }) {
    this.server.to(`room:${roomId}`).emit('chaos:updated', { value: chaos.value });
    if (chaos.triggered) this.server.to(`room:${roomId}`).emit('chaos:rule_triggered', { rule: chaos.rule, endsAt: chaos.endsAt });
  }

  private detectFormat(text: string) { return /(^|\n)(const |let |for \(|if \(|try \{|function )/.test(text) ? 'CODE' : 'PLAIN'; }
  private parse(value: unknown) { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return {}; } }
}
