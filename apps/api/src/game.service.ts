import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { DbService } from './db.service';
import { LlmService } from './llm.service';
import { RedisService } from './redis.service';

type ConflictSide = { key: string; targetWord: string; forbiddenWord: string; text: string };
type ConflictPair = { pairKey: string; sideA: ConflictSide; sideB: ConflictSide };

const CONFLICT_PAIRS: ConflictPair[] = [
  {
    pairKey: 'WORK',
    sideA: { key: 'MAKE_SAY_OVERTIME', targetWord: '加班', forbiddenWord: '涨薪', text: '让对手说出「加班」，但你自己绝不能说出「涨薪」。' },
    sideB: { key: 'MAKE_SAY_RAISE', targetWord: '涨薪', forbiddenWord: '加班', text: '让对手说出「涨薪」，但你自己绝不能说出「加班」。' },
  },
  {
    pairKey: 'BOSS',
    sideA: { key: 'MAKE_SAY_BOSS', targetWord: '老板', forbiddenWord: '辞职', text: '让对手说出「老板」，但你自己绝不能说出「辞职」。' },
    sideB: { key: 'MAKE_SAY_QUIT', targetWord: '辞职', forbiddenWord: '老板', text: '让对手说出「辞职」，但你自己绝不能说出「老板」。' },
  },
  {
    pairKey: 'LOVE',
    sideA: { key: 'MAKE_SAY_LOVE', targetWord: '爱你', forbiddenWord: '分手', text: '让对手说出「爱你」，但你自己绝不能说出「分手」。' },
    sideB: { key: 'MAKE_SAY_BREAKUP', targetWord: '分手', forbiddenWord: '爱你', text: '让对手说出「分手」，但你自己绝不能说出「爱你」。' },
  },
];

const COMEDY_MISSIONS = [
  { key: 'ANIMAL_TALK', minMessages: 3, text: '领取后你的最近 3 条发言，每条都必须包含一个完全不相关的动物。' },
  { key: 'QUESTION_STREAK', minMessages: 3, text: '领取后连续 3 条发言都必须是疑问句。' },
  { key: 'START_QISHI', minMessages: 3, text: '领取后你的最近 3 条发言，每条都以「其实」开头。' },
  { key: 'ANCIENT_STYLE', minMessages: 2, text: '领取后用文言文的腔调描述一件现代物品，至少 2 条发言。' },
];

const COOPERATIVE_MISSIONS = [
  { key: 'STORY_CHAIN', minMessages: 6, text: '全房接力讲一个连贯的故事，连续至少 6 条相关发言。' },
  { key: 'EVERYONE_SPEAKS', minMessages: 0, text: '让房间里的每个人都至少发过 1 条消息。' },
];

const CHAOS_RULES = [
  { key: 'QUESTION_ONLY', text: '接下来 30 秒，所有人只能使用疑问句。' },
  { key: 'LAST_WORDS', text: '接下来 30 秒，每句话都必须假装这是最后一句遗言。' },
  { key: 'MIMIC_LAST', text: '接下来 30 秒，所有人物开始互相串味：请模仿上一位发言者。' },
  { key: 'NO_PRONOUNS', text: '接下来 30 秒，禁止使用“我、你、他”。' },
  { key: 'ANIMAL', text: '接下来 30 秒，每句话必须包含一个完全不相关的动物。' },
];

const REWARD_POINTS = { CONFLICT: 40, COMEDY: 20, COOPERATIVE: 30 } as const;

export type ActiveRule = { id: string; key: string; rule: string; endsAt: number };
export type MissionType = 'CONFLICT' | 'COMEDY' | 'COOPERATIVE';
export type ScoreEntry = { memberId: number; nickname: string; score: number };
export type ChaosState = { value: number; activeRules: ActiveRule[] };
type MissionPayload = {
  type: MissionType;
  pairKey?: string;
  side?: 'A' | 'B';
  targetMemberId?: number | null;
  targetWord?: string;
  forbiddenWord?: string;
  minMessages?: number;
  rewardPoints: number;
};
type AssignedMission = { publicId: string; text: string; status: string; type: MissionType; rewardPoints: number; isNew: boolean };
type ClaimResult = {
  ok: boolean;
  verdict: 'YES' | 'NO';
  reason: string;
  cooldownMs?: number;
  scoreGained?: number;
  leaderboard?: ScoreEntry[];
  chaos?: ChaosState;
  failedOpponent?: number | null;
};

@Injectable()
export class GameService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly llm: LlmService,
  ) {}

  async assignMission(roomId: number, memberId: number): Promise<AssignedMission> {
    const existing = await this.db.rows<RowDataPacket[]>(
      'SELECT public_id,mission_text,status,mission_payload FROM room_missions WHERE room_id=? AND room_member_id=? LIMIT 1',
      [roomId, memberId],
    );
    if (existing.length) {
      const payload = this.parsePayload(existing[0].mission_payload);
      return { publicId: existing[0].public_id, text: existing[0].mission_text, status: existing[0].status, type: payload.type, rewardPoints: payload.rewardPoints, isNew: false };
    }

    const roll = Math.random();
    const type: MissionType = roll < 0.5 ? 'CONFLICT' : roll < 0.8 ? 'COMEDY' : 'COOPERATIVE';
    const rewardPoints = REWARD_POINTS[type];
    let key = '';
    let text = '';
    let payload: MissionPayload = { type, rewardPoints };
    let pairUpdate: { id: number; payload: MissionPayload } | null = null;

    if (type === 'CONFLICT') {
      const rows = await this.db.rows<RowDataPacket[]>(
        `SELECT id,room_member_id,mission_payload FROM room_missions WHERE room_id=? AND status='ASSIGNED' AND mission_payload LIKE '%CONFLICT%'`,
        [roomId],
      );
      let openId: number | null = null;
      let openMemberId: number | null = null;
      let openPayload: MissionPayload | null = null;
      for (const row of rows) {
        const p = this.parsePayload(row.mission_payload);
        if (p.type === 'CONFLICT' && p.pairKey && !p.targetMemberId) {
          openId = Number(row.id);
          openMemberId = Number(row.room_member_id);
          openPayload = p;
          break;
        }
      }
      if (openId && openMemberId && openPayload) {
        const pair = CONFLICT_PAIRS.find(item => item.pairKey === openPayload!.pairKey)!;
        const side = openPayload.side === 'A' ? 'B' : 'A';
        const def = side === 'A' ? pair.sideA : pair.sideB;
        key = def.key;
        text = def.text;
        payload = { type, pairKey: pair.pairKey, side, targetMemberId: openMemberId, targetWord: def.targetWord, forbiddenWord: def.forbiddenWord, rewardPoints };
        pairUpdate = { id: openId, payload: { ...openPayload, targetMemberId: memberId } };
      } else {
        const pair = CONFLICT_PAIRS[Math.floor(Math.random() * CONFLICT_PAIRS.length)];
        const def = pair.sideA;
        key = def.key;
        text = def.text;
        payload = { type, pairKey: pair.pairKey, side: 'A', targetMemberId: null, targetWord: def.targetWord, forbiddenWord: def.forbiddenWord, rewardPoints };
      }
    } else if (type === 'COOPERATIVE') {
      const def = COOPERATIVE_MISSIONS[Math.floor(Math.random() * COOPERATIVE_MISSIONS.length)];
      key = def.key;
      text = def.text;
      payload = { type, minMessages: def.minMessages, rewardPoints };
    } else {
      const def = COMEDY_MISSIONS[Math.floor(Math.random() * COMEDY_MISSIONS.length)];
      key = def.key;
      text = def.text;
      payload = { type, minMessages: def.minMessages, rewardPoints };
    }

    const publicId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    try {
      await this.db.pool.execute<ResultSetHeader>(
        'INSERT INTO room_missions(public_id,room_id,room_member_id,mission_key,mission_text,mission_payload) VALUES(?,?,?,?,?,?)',
        [publicId, roomId, memberId, key, text, JSON.stringify(payload)],
      );
      if (pairUpdate) {
        await this.db.pool.execute('UPDATE room_missions SET mission_payload=? WHERE id=?', [JSON.stringify(pairUpdate.payload), pairUpdate.id]);
      }
      return { publicId, text, status: 'ASSIGNED', type, rewardPoints, isNew: true };
    } catch {
      return this.assignMission(roomId, memberId);
    }
  }

  async claimMission(roomId: number, memberId: number, missionPublicId: string): Promise<ClaimResult> {
    const rows = await this.db.rows<RowDataPacket[]>(
      'SELECT id,mission_text,mission_payload,status,assigned_at FROM room_missions WHERE public_id=? AND room_id=? AND room_member_id=? LIMIT 1',
      [missionPublicId, roomId, memberId],
    );
    if (!rows.length) throw new Error('任务不存在');
    const mission = rows[0];
    if (mission.status === 'COMPLETED') {
      return { ok: true, verdict: 'YES', reason: '这个任务已经完成过了。', leaderboard: await this.leaderboard(roomId) };
    }
    if (mission.status === 'FAILED') {
      return { ok: true, verdict: 'NO', reason: '这个任务已经失败了。' };
    }

    const cooldownKey = `mission:claim:cooldown:${memberId}`;
    const cooling = await this.redis.client.get(cooldownKey);
    if (cooling) {
      return { ok: true, verdict: 'NO', reason: '刚判定过，请稍等一会儿再试。', cooldownMs: Number(cooling) };
    }

    const payload = this.parsePayload(mission.mission_payload);
    const assignedAt = mission.assigned_at;

    const gate = await this.verify(roomId, memberId, payload, assignedAt);
    if (!gate.pass) {
      await this.redis.client.set(cooldownKey, '60000', { EX: 60 });
      return { ok: true, verdict: 'NO', reason: gate.reason, cooldownMs: 60_000 };
    }

    let reason = gate.reason;
    if (payload.type === 'COMEDY' || (payload.type === 'COOPERATIVE' && payload.minMessages)) {
      const claimant = await this.claimantInfo(memberId);
      const transcript = await this.transcriptSince(roomId, assignedAt);
      const judgement = await this.llm.judgeMission(mission.mission_text, claimant, transcript);
      if (judgement.verdict === 'NO') {
        await this.redis.client.set(cooldownKey, '60000', { EX: 60 });
        return { ok: true, verdict: 'NO', reason: judgement.reason, cooldownMs: 60_000 };
      }
      reason = judgement.reason;
    }

    const [res] = await this.db.pool.execute<ResultSetHeader>(
      `UPDATE room_missions SET status='COMPLETED',completed_at=NOW(3) WHERE id=? AND status='ASSIGNED'`,
      [mission.id],
    );
    if (res.affectedRows === 0) {
      return { ok: true, verdict: 'NO', reason: '任务状态已变化，请刷新。' };
    }

    let failedOpponent: number | null = null;
    if (payload.type === 'CONFLICT' && payload.pairKey && payload.targetMemberId) {
      const [op] = await this.db.pool.execute<ResultSetHeader>(
        `UPDATE room_missions SET status='FAILED' WHERE room_id=? AND room_member_id=? AND mission_payload LIKE ? AND status='ASSIGNED'`,
        [roomId, payload.targetMemberId, `%${payload.pairKey}%`],
      );
      if (op.affectedRows > 0) failedOpponent = payload.targetMemberId;
    }

    await this.redis.client.zIncrBy(`room:${roomId}:leaderboard`, payload.rewardPoints, String(memberId));
    await this.redis.client.expire(`room:${roomId}:leaderboard`, 7200);
    await this.redis.client.del(cooldownKey);

    const chaos = payload.type === 'CONFLICT'
      ? await this.addChaos(roomId, 30)
      : payload.type === 'COOPERATIVE'
        ? await this.reduceChaos(roomId, 20)
        : await this.reduceChaos(roomId, 10);

    return {
      ok: true,
      verdict: 'YES',
      reason,
      scoreGained: payload.rewardPoints,
      leaderboard: await this.leaderboard(roomId),
      chaos,
      failedOpponent,
    };
  }

  async leaderboard(roomId: number): Promise<ScoreEntry[]> {
    const entries = await this.redis.client.zRangeWithScores(`room:${roomId}:leaderboard`, 0, -1, { REV: true });
    if (!entries.length) return [];
    const rows = await this.db.rows<RowDataPacket[]>(
      'SELECT rm.id member_id,u.nickname FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=?',
      [roomId],
    );
    const nick = new Map(rows.map(row => [Number(row.member_id), String(row.nickname)]));
    return entries.map(entry => ({ memberId: Number(entry.value), nickname: nick.get(Number(entry.value)) || '神秘人', score: Number(entry.score) }));
  }

  async addChaos(roomId: number, amount: number) {
    const key = `room:${roomId}:chaos`;
    const value = await this.redis.client.incrBy(key, amount);
    await this.redis.client.expire(key, 3600);
    const activeRules = await this.currentRules(roomId);
    if (value < 100) return { value, triggered: false as const, activeRules };

    await this.redis.client.set(key, '0', { EX: 3600 });
    const existingKeys = new Set(activeRules.map(rule => rule.key));
    const candidates = CHAOS_RULES.filter(rule => !existingKeys.has(rule.key));
    const pool = candidates.length ? candidates : CHAOS_RULES;
    const rule = pool[Math.floor(Math.random() * pool.length)];
    const endsAt = Date.now() + 30_000;
    await this.redis.client.hSet(`room:${roomId}:chaos:rules`, randomUUID(), JSON.stringify({ key: rule.key, rule: rule.text, endsAt }));
    return { value: 0, triggered: true as const, activeRules: await this.currentRules(roomId) };
  }

  async currentChaos(roomId: number) {
    const [value, activeRules] = await Promise.all([
      this.redis.client.get(`room:${roomId}:chaos`),
      this.currentRules(roomId),
    ]);
    return { value: Number(value || 0), activeRules };
  }

  private async reduceChaos(roomId: number, amount: number) {
    const key = `room:${roomId}:chaos`;
    const next = Math.max(0, Number(await this.redis.client.get(key) || 0) - amount);
    await this.redis.client.set(key, String(next), { EX: 3600 });
    return { value: next, triggered: false as const, activeRules: await this.currentRules(roomId) };
  }

  private async verify(roomId: number, memberId: number, payload: MissionPayload, since: Date | string): Promise<{ pass: boolean; reason: string }> {
    if (payload.type === 'CONFLICT') {
      if (!payload.targetMemberId) return { pass: false, reason: '你的对手还没就位，暂时无法判定。' };
      const targetWord = payload.targetWord!;
      const forbiddenWord = payload.forbiddenWord!;
      const opponentTexts = await this.textsSince(roomId, payload.targetMemberId, since);
      const selfTexts = await this.textsSince(roomId, memberId, since);
      const opponentSaid = opponentTexts.join('\n').includes(targetWord);
      const selfSlipped = selfTexts.join('\n').includes(forbiddenWord);
      if (!opponentSaid) return { pass: false, reason: `对手还没说出「${targetWord}」，再引导引导。` };
      if (selfSlipped) return { pass: false, reason: `你自己先说出了禁忌词「${forbiddenWord}」，本任务判负。` };
      return { pass: true, reason: `对手说出了「${targetWord}」，达成！` };
    }

    if (payload.type === 'COMEDY') {
      const count = await this.messageCount(roomId, since, memberId);
      const min = payload.minMessages ?? 1;
      if (count < min) return { pass: false, reason: `你领取后只发过 ${count} 条消息，需要至少 ${min} 条才算有足够证据。` };
      return { pass: true, reason: '证据已提交，请裁判复核。' };
    }

    if (payload.minMessages) {
      const count = await this.messageCount(roomId, since);
      if (count < payload.minMessages) return { pass: false, reason: `领取后全房只发了 ${count} 条消息，需要至少 ${payload.minMessages} 条。` };
      return { pass: true, reason: '证据已提交，请裁判复核。' };
    }

    const active = await this.db.rows<RowDataPacket[]>('SELECT COUNT(*) c FROM room_members WHERE room_id=? AND member_status="JOINED"', [roomId]);
    const spoken = await this.db.rows<RowDataPacket[]>('SELECT COUNT(DISTINCT room_member_id) c FROM messages WHERE room_id=? AND created_at>?', [roomId, since]);
    const need = Number(active[0]?.c || 0);
    const have = Number(spoken[0]?.c || 0);
    if (have < need) return { pass: false, reason: `还有 ${need - have} 位成员没发言。` };
    return { pass: true, reason: `全员 ${need} 人都发过言了，达成！` };
  }

  private async messageCount(roomId: number, since: Date | string, memberId?: number): Promise<number> {
    const rows = await this.db.rows<RowDataPacket[]>(
      memberId != null
        ? 'SELECT COUNT(*) c FROM messages WHERE room_id=? AND room_member_id=? AND created_at>?'
        : 'SELECT COUNT(*) c FROM messages WHERE room_id=? AND created_at>?',
      memberId != null ? [roomId, memberId, since] : [roomId, since],
    );
    return Number(rows[0]?.c || 0);
  }

  private async textsSince(roomId: number, memberId: number, since: Date | string): Promise<string[]> {
    const rows = await this.db.rows<RowDataPacket[]>(
      'SELECT transformed_text FROM messages WHERE room_id=? AND room_member_id=? AND created_at>? ORDER BY sequence_no ASC',
      [roomId, memberId, since],
    );
    return rows.map(row => String(row.transformed_text || ''));
  }

  private async transcriptSince(roomId: number, since: Date | string): Promise<string> {
    const rows = await this.db.rows<RowDataPacket[]>(
      `SELECT u.nickname,p.name persona_name,m.transformed_text
       FROM messages m JOIN room_members rm ON rm.id=m.room_member_id
       JOIN users u ON u.id=m.user_id JOIN personas p ON p.id=m.persona_id
       WHERE m.room_id=? AND m.created_at>? ORDER BY m.sequence_no ASC LIMIT 40`,
      [roomId, since],
    );
    return rows.map((row, index) => `${index + 1}. ${row.nickname}(${row.persona_name})：${row.transformed_text}`).join('\n');
  }

  private async currentRules(roomId: number): Promise<ActiveRule[]> {
    const rulesKey = `room:${roomId}:chaos:rules`;
    const raw = await this.redis.client.hGetAll(rulesKey);
    const now = Date.now();
    const active: ActiveRule[] = [];
    const expired: string[] = [];
    for (const [id, json] of Object.entries(raw)) {
      const parsed = JSON.parse(json) as Omit<ActiveRule, 'id'>;
      if (parsed.endsAt > now) active.push({ id, ...parsed });
      else expired.push(id);
    }
    if (expired.length) await this.redis.client.hDel(rulesKey, expired);
    return active.sort((a, b) => a.endsAt - b.endsAt);
  }

  private async claimantInfo(memberId: number) {
    const rows = await this.db.rows<RowDataPacket[]>(
      `SELECT u.nickname,p.name persona_name FROM room_members rm JOIN users u ON u.id=rm.user_id JOIN personas p ON p.id=rm.current_persona_id WHERE rm.id=? LIMIT 1`,
      [memberId],
    );
    return { nickname: String(rows[0]?.nickname || '神秘人'), personaName: String(rows[0]?.persona_name || '神秘人物') };
  }

  private parsePayload(value: unknown): MissionPayload {
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { /* ignore */ } }
    if (value && typeof value === 'object') return value as MissionPayload;
    return { type: 'COMEDY', rewardPoints: REWARD_POINTS.COMEDY };
  }
}
