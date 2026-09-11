import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { DbService } from './db.service';
import { RedisService } from './redis.service';

const CONFLICT_MISSIONS = [
  { key: 'PUSH_WORK', text: '让房间里至少两个人主动聊到“工作”，但你不能先说出这两个字。', side: 'WORK' },
  { key: 'BLOCK_WORK', text: '阻止任何人把话题引向工作；如果有人接近，立刻把话题带走。', side: 'ANTI_WORK' },
  { key: 'FORCE_SWITCH', text: '让另一名成员主动切换一次人物身份，不能直接要求对方切换。', side: 'SWITCH' },
  { key: 'DETECT_MISSION', text: '找出谁正在阻止大家聊工作，并用当前人物的口吻公开指认。', side: 'DETECT' },
  { key: 'EGG_SECRET', text: '不出现“蛋”和“早餐”，让至少一人猜出你早上吃了鸡蛋。', side: 'EGG' },
  { key: 'QUESTION_ONLY', text: '连续三次发言都使用疑问句，但不能被别人发现这是任务。', side: 'STYLE' },
];

const CHAOS_RULES = [
  '接下来 30 秒，所有人只能使用疑问句。',
  '接下来 30 秒，每句话都必须假装这是最后一句遗言。',
  '接下来 30 秒，所有人物开始互相串味：请模仿上一位发言者。',
  '接下来 30 秒，禁止使用“我、你、他”。',
  '接下来 30 秒，每句话必须包含一个完全不相关的动物。',
];

@Injectable()
export class GameService {
  constructor(private readonly db: DbService, private readonly redis: RedisService) {}

  async assignMission(roomId: number, memberId: number): Promise<{ publicId: string; text: string; status: string; isNew: boolean }> {
    const existing = await this.db.rows<RowDataPacket[]>(
      'SELECT public_id,mission_text,status FROM room_missions WHERE room_id=? AND room_member_id=? LIMIT 1',
      [roomId, memberId],
    );
    if (existing.length) return { publicId: existing[0].public_id, text: existing[0].mission_text, status: existing[0].status, isNew: false };

    const countRows = await this.db.rows<RowDataPacket[]>('SELECT COUNT(*) total FROM room_missions WHERE room_id=?', [roomId]);
    const mission = CONFLICT_MISSIONS[Number(countRows[0].total) % CONFLICT_MISSIONS.length];
    const publicId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    try {
      await this.db.pool.execute<ResultSetHeader>(
        'INSERT INTO room_missions(public_id,room_id,room_member_id,mission_key,mission_text,mission_payload) VALUES(?,?,?,?,?,?)',
        [publicId, roomId, memberId, mission.key, mission.text, JSON.stringify({ side: mission.side })],
      );
      return { publicId, text: mission.text, status: 'ASSIGNED', isNew: true };
    } catch {
      return this.assignMission(roomId, memberId);
    }
  }

  async addChaos(roomId: number, amount: number) {
    const key = `room:${roomId}:chaos`;
    const value = await this.redis.client.incrBy(key, amount);
    await this.redis.client.expire(key, 3600);
    if (value < 100) return { value, triggered: false as const };

    const lockKey = `room:${roomId}:chaos:trigger-lock`;
    const locked = await this.redis.client.set(lockKey, '1', { NX: true, EX: 30 });
    if (!locked) return { value: 100, triggered: false as const };
    await this.redis.client.set(key, '0', { EX: 3600 });
    const rule = CHAOS_RULES[Math.floor(Math.random() * CHAOS_RULES.length)];
    const endsAt = Date.now() + 30_000;
    await this.redis.client.set(`room:${roomId}:chaos:rule`, JSON.stringify({ rule, endsAt }), { EX: 30 });
    return { value: 0, triggered: true as const, rule, endsAt };
  }

  async currentChaos(roomId: number) {
    const [value, rawRule] = await Promise.all([
      this.redis.client.get(`room:${roomId}:chaos`),
      this.redis.client.get(`room:${roomId}:chaos:rule`),
    ]);
    return { value: Number(value || 0), activeRule: rawRule ? JSON.parse(rawRule) : null };
  }
}
