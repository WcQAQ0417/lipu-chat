import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { DbService } from './db.service';
import { RedisService } from './redis.service';
import { config } from './config';

const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

@Injectable()
export class RoomService {
  constructor(private readonly db: DbService, private readonly redis: RedisService) {}

  async list() {
    const rows = await this.db.rows<RowDataPacket[]>(
      `SELECT room_code,name,room_type,status,max_members,created_at FROM rooms
       WHERE status IN ('ACTIVE','EMPTY_GRACE') ORDER BY created_at DESC LIMIT 30`,
    );
    return rows.map(row => ({ code: row.room_code, name: row.name, type: row.room_type, status: row.status, maxMembers: row.max_members }));
  }

  async find(code: string) {
    const normalized = code.toUpperCase();
    const rows = await this.db.rows<RowDataPacket[]>('SELECT * FROM rooms WHERE room_code=? LIMIT 1', [normalized]);
    if (!rows.length || rows[0].status === 'DESTROYED') throw new NotFoundException('没有找到可加入的房间');
    return rows[0];
  }

  async create(userId: number, input: { name?: string; type?: string }) {
    const name = (input.name || '未命名离谱现场').trim().slice(0, 80);
    const type = input.type === 'THEME' ? 'THEME' : 'NORMAL';
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.code();
      try {
        const [result] = await this.db.pool.execute<ResultSetHeader>(
          'INSERT INTO rooms(public_id,room_code,owner_user_id,name,room_type) VALUES(?,?,?,?,?)',
          [this.publicId(), code, userId, name, type],
        );
        await this.redis.client.set(`room:code:${code}`, String(result.insertId));
        return { code, name, type };
      } catch (error: any) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
      }
    }
    throw new BadRequestException('房间 ID 生成冲突，请重试');
  }

  async join(room: RowDataPacket, userId: number, personaPublicId: string) {
    const personas = await this.db.rows<RowDataPacket[]>(
      'SELECT id,public_id,name,version,enabled FROM personas WHERE public_id=? AND deleted_at IS NULL LIMIT 1',
      [personaPublicId],
    );
    if (!personas.length || !personas[0].enabled) throw new BadRequestException('人物未启用或不存在');

    const memberId = await this.db.transaction(async connection => {
      const [locked] = await connection.query<RowDataPacket[]>('SELECT status FROM rooms WHERE id=? FOR UPDATE', [room.id]);
      if (!locked.length || locked[0].status === 'DESTROYING' || locked[0].status === 'DESTROYED') throw new BadRequestException('房间正在销毁');
      const [existing] = await connection.query<RowDataPacket[]>('SELECT id FROM room_members WHERE room_id=? AND user_id=?', [room.id, userId]);
      if (existing.length) {
        await connection.execute('UPDATE room_members SET current_persona_id=?,member_status=\'JOINED\',left_at=NULL,last_seen_at=NOW(3) WHERE id=?', [personas[0].id, existing[0].id]);
        return Number(existing[0].id);
      }
      const [inserted] = await connection.execute<ResultSetHeader>(
        'INSERT INTO room_members(public_id,room_id,user_id,current_persona_id) VALUES(?,?,?,?)',
        [this.publicId(), room.id, userId, personas[0].id],
      );
      return inserted.insertId;
    });
    await this.db.pool.execute("UPDATE rooms SET status='ACTIVE',empty_since=NULL,destroy_after=NULL WHERE id=? AND status='EMPTY_GRACE'", [room.id]);
    await this.redis.client.zRem('room:destroy:schedule', String(room.id));
    return { memberId, persona: personas[0] };
  }

  async scheduleIfEmpty(roomId: number) {
    const online = await this.redis.client.sCard(`room:${roomId}:presence`);
    if (online > 0) return false;
    const destroyAt = Date.now() + config.roomEmptyTtlSeconds * 1000;
    await this.db.pool.execute(
      "UPDATE rooms SET status='EMPTY_GRACE',empty_since=NOW(3),destroy_after=DATE_ADD(NOW(3),INTERVAL ? SECOND) WHERE id=? AND status='ACTIVE'",
      [config.roomEmptyTtlSeconds, roomId],
    );
    await this.redis.client.zAdd('room:destroy:schedule', [{ score: destroyAt, value: String(roomId) }]);
    return true;
  }

  async destroyDueRooms() {
    const due = await this.redis.client.zRangeByScore('room:destroy:schedule', 0, Date.now(), { LIMIT: { offset: 0, count: 100 } });
    for (const rawId of due) {
      const roomId = Number(rawId);
      if (await this.redis.client.sCard(`room:${roomId}:presence`)) { await this.redis.client.zRem('room:destroy:schedule', rawId); continue; }
      const [result] = await this.db.pool.execute<ResultSetHeader>(
        "UPDATE rooms SET status='DESTROYING' WHERE id=? AND status='EMPTY_GRACE' AND destroy_after<=NOW(3)", [roomId],
      );
      if (!result.affectedRows) { await this.redis.client.zRem('room:destroy:schedule', rawId); continue; }
      const rows = await this.db.rows<RowDataPacket[]>('SELECT room_code FROM rooms WHERE id=?', [roomId]);
      await this.db.pool.execute('DELETE FROM messages WHERE room_id=?', [roomId]);
      await this.db.pool.execute('DELETE FROM room_missions WHERE room_id=?', [roomId]);
      await this.db.pool.execute("UPDATE rooms SET status='DESTROYED',destroyed_at=NOW(3) WHERE id=?", [roomId]);
      if (rows.length) await this.redis.client.del(`room:code:${rows[0].room_code}`);
      await this.redis.client.del([`room:${roomId}:chaos`, `room:${roomId}:chaos:rule`, `room:${roomId}:presence`]);
      await this.redis.client.zRem('room:destroy:schedule', rawId);
    }
  }

  private code() { return Array.from({ length: 8 }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join(''); }
  private publicId() { return randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase(); }
}

