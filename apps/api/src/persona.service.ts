import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { z } from 'zod';
import { DbService } from './db.service';

export const personaInput = z.object({
  name: z.string().trim().min(1).max(40),
  shortDescription: z.string().trim().min(1).max(160),
  identityBackground: z.string().trim().min(1).max(3000),
  speakingHabits: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
  attitudeStyle: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
  transformRules: z.array(z.string().trim().min(1).max(300)).min(1).max(16),
  examples: z.array(z.object({ input: z.string().max(500), output: z.string().max(1500) })).max(8).default([]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c7ff00'),
  symbol: z.string().trim().min(1).max(3).default('角'),
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'UNLISTED']).default('PUBLIC'),
});

@Injectable()
export class PersonaService {
  constructor(private readonly db: DbService) {}

  async list(enabledOnly = false) {
    const rows = await this.db.rows<RowDataPacket[]>(
      `SELECT public_id,name,short_description,identity_background,speaking_habits,attitude_style,
              transform_rules,example_dialogues,visual_config,visibility,enabled,version,created_at
       FROM personas WHERE deleted_at IS NULL ${enabledOnly ? 'AND enabled=1' : ''} ORDER BY id DESC`,
    );
    return rows.map(this.map);
  }

  async findByPublicId(publicId: string) {
    const rows = await this.db.rows<RowDataPacket[]>(
      'SELECT * FROM personas WHERE public_id=? AND deleted_at IS NULL LIMIT 1', [publicId],
    );
    if (!rows.length) throw new NotFoundException('人物不存在');
    return rows[0];
  }

  async create(ownerId: number, input: unknown) {
    const data = personaInput.parse(input);
    const publicId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    await this.db.pool.execute(
      `INSERT INTO personas(public_id,owner_user_id,name,short_description,identity_background,
       speaking_habits,attitude_style,transform_rules,example_dialogues,visual_config,visibility)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [publicId, ownerId, data.name, data.shortDescription, data.identityBackground,
       JSON.stringify(data.speakingHabits), JSON.stringify(data.attitudeStyle), JSON.stringify(data.transformRules),
       JSON.stringify(data.examples), JSON.stringify({ color: data.color, symbol: data.symbol }), data.visibility],
    );
    return { publicId };
  }

  async update(publicId: string, ownerId: number, input: unknown) {
    const data = personaInput.partial().parse(input);
    const current = await this.findByPublicId(publicId);
    if (Number(current.owner_user_id) !== ownerId) throw new BadRequestException('只能修改自己创建的人物');
    const snapshot = this.map(current);
    await this.db.transaction(async connection => {
      await connection.execute(
        'INSERT IGNORE INTO persona_versions(persona_id,version,snapshot,created_by) VALUES(?,?,?,?)',
        [current.id, current.version, JSON.stringify(snapshot), ownerId],
      );
      const merged = {
        name: data.name ?? current.name,
        shortDescription: data.shortDescription ?? current.short_description,
        identityBackground: data.identityBackground ?? current.identity_background,
        speakingHabits: data.speakingHabits ?? this.json(current.speaking_habits),
        attitudeStyle: data.attitudeStyle ?? this.json(current.attitude_style),
        transformRules: data.transformRules ?? this.json(current.transform_rules),
        examples: data.examples ?? this.json(current.example_dialogues),
        visual: { ...this.json(current.visual_config), ...(data.color ? { color: data.color } : {}), ...(data.symbol ? { symbol: data.symbol } : {}) },
        visibility: data.visibility ?? current.visibility,
      };
      await connection.execute(
        `UPDATE personas SET name=?,short_description=?,identity_background=?,speaking_habits=?,attitude_style=?,
         transform_rules=?,example_dialogues=?,visual_config=?,visibility=?,version=version+1 WHERE id=?`,
        [merged.name, merged.shortDescription, merged.identityBackground, JSON.stringify(merged.speakingHabits),
         JSON.stringify(merged.attitudeStyle), JSON.stringify(merged.transformRules), JSON.stringify(merged.examples),
         JSON.stringify(merged.visual), merged.visibility, current.id],
      );
    });
    return { ok: true };
  }

  async setEnabled(publicId: string, ownerId: number, enabled: boolean) {
    const current = await this.findByPublicId(publicId);
    if (Number(current.owner_user_id) !== ownerId) throw new BadRequestException('只能管理自己创建的人物');
    await this.db.pool.execute('UPDATE personas SET enabled=? WHERE id=?', [enabled ? 1 : 0, current.id]);
    return { ok: true, enabled };
  }

  async remove(publicId: string, ownerId: number) {
    const current = await this.findByPublicId(publicId);
    if (Number(current.owner_user_id) !== ownerId) throw new BadRequestException('只能删除自己创建的人物');
    await this.db.pool.execute('UPDATE personas SET enabled=0,deleted_at=NOW(3) WHERE id=?', [current.id]);
    return { ok: true };
  }

  map = (row: RowDataPacket) => ({
    publicId: row.public_id,
    name: row.name,
    shortDescription: row.short_description,
    identityBackground: row.identity_background,
    speakingHabits: this.json(row.speaking_habits),
    attitudeStyle: this.json(row.attitude_style),
    transformRules: this.json(row.transform_rules),
    examples: this.json(row.example_dialogues),
    visual: this.json(row.visual_config),
    visibility: row.visibility,
    enabled: Boolean(row.enabled),
    version: Number(row.version),
  });

  private json(value: unknown) {
    if (value == null) return [];
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { return []; } }
    return value;
  }
}

