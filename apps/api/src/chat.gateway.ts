import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer, WsException } from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { Server, Socket } from 'socket.io';
import { AuthService } from './auth.service';
import { DbService } from './db.service';
import { GameService } from './game.service';
import type { ActiveRule } from './game.service';
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
      Object.assign(data, { roomId: room.id, roomCode: room.code, memberId: joined.memberId });
      await client.join(`room:${room.id}`);
      await this.redis.client.sAdd(`room:${room.id}:presence`, String(joined.memberId));
      await this.redis.client.sAdd(`room:${room.id}:member:${joined.memberId}:sockets`, client.id);
      await this.redis.client.expire(`room:${room.id}:member:${joined.memberId}:sockets`, 600);
      const mission = room.type === 'THEME' ? await this.game.assignMission(room.id, joined.memberId) : null;
      const chaos = await this.game.currentChaos(room.id);
      const leaderboard = await this.game.leaderboard(room.id);
      const messages = await this.loadMessages(room.id);
      client.to(`room:${room.id}`).emit('member:joined', { memberId: joined.memberId, nickname: data.nickname, personaName: joined.persona.name });
      return { ok: true, room: { code: room.code, name: room.name, type: room.type }, memberId: joined.memberId, mission, chaos, leaderboard, messages };
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
    const idemKey = `idem:message:${data.uid}:${body.clientMessageId}`;
    const existing = await this.redis.client.get(idemKey);
    if (existing) return { ok: true, duplicate: true, message: JSON.parse(existing) };
    const memberRows = await this.db.rows<RowDataPacket[]>(
      `SELECT p.*,rm.id member_id FROM room_members rm JOIN personas p ON p.id=rm.current_persona_id
       WHERE rm.id=? AND rm.user_id=? AND rm.member_status='JOINED' LIMIT 1`, [data.memberId, data.uid],
    );
    if (!memberRows.length || !memberRows[0].enabled) throw new WsException('当前人物不可用，请切换人物');
    const persona = memberRows[0];
    const chaos = await this.game.currentChaos(data.roomId!);
    const ruleText = chaos.activeRules.map(rule => rule.rule).join('；');
    const transformedText = (await this.llm.transform(original, persona as PersonaLike, '', ruleText)).slice(0, 1500);

    const sequenceNo = await this.redis.client.incr(`room:${data.roomId}:seq`);
    const publicId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    const snapshot = this.personas.map(persona);
    await this.db.pool.execute<ResultSetHeader>(
      `INSERT INTO messages(public_id,client_message_id,room_id,room_member_id,user_id,persona_id,persona_version,
       persona_snapshot,original_text,transformed_text,content_format,transform_status,sequence_no)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [publicId, body.clientMessageId, data.roomId, data.memberId, data.uid, persona.id, persona.version,
       JSON.stringify(snapshot), original, transformedText, this.detectFormat(transformedText), 'SUCCEEDED', sequenceNo],
    );
    const message = { publicId, sequenceNo, sender: { memberId: data.memberId, nickname: data.nickname }, persona: snapshot, text: transformedText, createdAt: new Date().toISOString() };
    await this.redis.client.set(idemKey, JSON.stringify(message), { EX: 600 });
    this.server.to(`room:${data.roomId}`).emit('message:ready', message);
    const chaosAfter = await this.game.addChaos(data.roomId!, 12 + Math.min(8, Math.floor(transformedText.length / 40)));
    this.broadcastChaos(data.roomId!, chaosAfter);
    return { ok: true, message };
  }

  @SubscribeMessage('mission:claim')
  async claimMission(@ConnectedSocket() client: Socket, @MessageBody() body: { missionPublicId: string }) {
    const data = this.requireRoom(client);
    const result = await this.game.claimMission(data.roomId!, data.memberId!, body.missionPublicId);
    if (result.verdict === 'YES') {
      this.server.to(`room:${data.roomId}`).emit('score:leaderboard', result.leaderboard);
      if (result.chaos) this.broadcastChaos(data.roomId!, result.chaos);
      if (result.failedOpponent) this.server.to(`room:${data.roomId}`).emit('mission:failed', { memberId: result.failedOpponent });
    }
    return result;
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

  private broadcastChaos(roomId: number, chaos: { value: number; activeRules: ActiveRule[] }) {
    this.server.to(`room:${roomId}`).emit('chaos:updated', { value: chaos.value });
    this.server.to(`room:${roomId}`).emit('chaos:rules', chaos.activeRules);
  }

  private detectFormat(text: string) { return /(^|\n)(const |let |for \(|if \(|try \{|function )/.test(text) ? 'CODE' : 'PLAIN'; }
  private parse(value: unknown) { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return {}; } }
}
