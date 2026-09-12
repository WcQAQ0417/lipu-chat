import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { DbService } from './db.service';
import { TokendanceService } from './tokendance.service';
import { RowDataPacket } from 'mysql2';
import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
}

@Controller('api/effects')
export class EffectsController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: DbService,
    private readonly tokendance: TokendanceService,
  ) {}

  @Get()
  async list() {
    const rows = await this.db.rows<RowDataPacket[]>(
      'SELECT public_id AS id, name, description, image_url, effect_type FROM effects WHERE enabled=1 ORDER BY created_at'
    );
    return rows;
  }

  @Post()
  async create(@Headers('authorization') token: string, @Body() body: {
    name: string; description?: string; prompt_template: string;
    image_url?: string; model?: string; effect_type?: string;
  }) {
    this.auth.verify(token);
    const id = newId();
    await this.db.pool.execute(
      `INSERT INTO effects(public_id,name,description,prompt_template,image_url,model,effect_type,enabled)
       VALUES(?,?,?,?,?,?,?,1)`,
      [id, body.name, body.description || '', body.prompt_template, body.image_url || null,
       body.model || 'seedream-5.0-lite', body.effect_type || 'IMAGE']
    );
    return { id, ok: true };
  }

  @Delete(':id')
  async remove(@Headers('authorization') token: string, @Param('id') id: string) {
    this.auth.verify(token);
    await this.db.pool.execute('DELETE FROM effects WHERE public_id=?', [id]);
    return { ok: true };
  }

  @Patch(':id/image')
  async uploadImage(
    @Headers('authorization') token: string,
    @Param('id') id: string,
    @Body() body: { image: string },
  ) {
    this.auth.verify(token);

    // 检查特效是否存在
    const effects = await this.db.rows<RowDataPacket[]>(
      'SELECT public_id FROM effects WHERE public_id=?', [id]
    );
    if (!effects.length) throw new Error('特效不存在');

    // 解码 base64 保存为文件
    const b64 = body.image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');
    const uploadDir = join(process.cwd(), 'uploads', 'effects');
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
    const filename = `${id}.jpg`;
    writeFileSync(join(uploadDir, filename), buffer);

    const url = `/uploads/effects/${filename}`;
    await this.db.pool.execute(
      'UPDATE effects SET image_url=? WHERE public_id=?', [url, id]
    );
    return { ok: true, image_url: url };
  }

  @Post('process')
  async process(
    @Headers('authorization') token: string,
    @Body() body: { effect_id: string; image?: string },
  ) {
    const user = this.auth.verify(token);

    const effects = await this.db.rows<RowDataPacket[]>(
      'SELECT * FROM effects WHERE public_id=? AND enabled=1', [body.effect_id]
    );
    if (!effects.length) throw new Error('特效不存在');
    const effect = effects[0] as RowDataPacket & { name: string; description: string; prompt_template: string };

    const logId = newId();
    // 只存图片引用（完整 base64 太长存不进 MySQL）
    const imgRef = body.image ? body.image.slice(0, 50) + '...' : '';
    await this.db.pool.execute(
      `INSERT INTO effect_logs(public_id,effect_id,user_id,original_image_url,status)
       VALUES(?,?,?,?,'PROCESSING')`,
      [logId, effect.id, user.uid, imgRef]
    );

    try {
      const prompt = `${effect.prompt_template}\n\n风格：动漫风格，高质量，细节丰富，明亮色彩。`;

      let resultUrl: string;
      if (body.image) {
        // 图文生图：提取 base64（去掉 data:image/...;base64, 前缀）
        const b64 = body.image.replace(/^data:image\/\w+;base64,/, '');
        resultUrl = await this.tokendance.generateImageWithRef(prompt, b64);
      } else {
        resultUrl = await this.tokendance.generateImage(prompt);
      }

      // 下载 seedream 返回的图片到本地（避免过期 / CORS 问题）
      const uploadDir = join(process.cwd(), 'uploads', 'effects');
      if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
      const localFile = `${logId}_result.jpg`;
      const localPath = join(uploadDir, localFile);
      try {
        const imgRes = await fetch(resultUrl);
        if (imgRes.ok) {
          const buf = await imgRes.arrayBuffer();
          writeFileSync(localPath, Buffer.from(buf));
          resultUrl = `/uploads/effects/${localFile}`;
        }
      } catch {
        // 下载失败就保持原 URL
      }

      await this.db.pool.execute(
        `UPDATE effect_logs SET result_image_url=?,status='SUCCEEDED' WHERE public_id=?`,
        [resultUrl, logId]
      );

      return { ok: true, result: resultUrl, description: effect.description || effect.name };
    } catch (err: any) {
      await this.db.pool.execute(
        `UPDATE effect_logs SET status='FAILED',error_message=? WHERE public_id=?`,
        [err.message?.slice(0, 500) || 'unknown error', logId]
      );
      throw err;
    }
  }

  @Post('generate-video')
  async generateVideo(
    @Headers('authorization') token: string,
    @Body() body: { effect_id: string; image_url: string },
  ) {
    const user = this.auth.verify(token);

    const effects = await this.db.rows<RowDataPacket[]>(
      'SELECT * FROM effects WHERE public_id=? AND enabled=1', [body.effect_id]
    );
    if (!effects.length) throw new Error('特效不存在');
    const effect = effects[0] as RowDataPacket & { name: string; prompt_template: string };

    const prompt = `${effect.prompt_template}\n\n风格：动漫风格，高质量，细节丰富，明亮色彩。`;

    // 寻找最近的 effect_log 以关联视频
    const logs = await this.db.rows<RowDataPacket[]>(
      `SELECT id FROM effect_logs WHERE effect_id=? AND user_id=? AND status='SUCCEEDED'
       ORDER BY created_at DESC LIMIT 1`,
      [effect.id, user.uid]
    );

    try {
      const videoUrl = await this.tokendance.generateVideo(body.image_url, prompt);
      if (logs.length) {
        await this.db.pool.execute(
          'UPDATE effect_logs SET video_url=? WHERE id=?', [videoUrl, logs[0].id]
        );
      }
      return { ok: true, video_url: videoUrl };
    } catch (err: any) {
      if (logs.length) {
        await this.db.pool.execute(
          'UPDATE effect_logs SET status=?, error_message=? WHERE id=?',
          ['FAILED', (err.message || '').slice(0, 500), logs[0].id]
        );
      }
      throw err;
    }
  }

  @Get('logs')
  async logs(@Headers('authorization') token: string) {
    const user = this.auth.verify(token);
    const rows = await this.db.rows<RowDataPacket[]>(
      `SELECT el.public_id AS id, el.status, el.result_image_url,
              el.video_url, el.error_message, el.created_at,
              e.name AS effect_name
       FROM effect_logs el
       LEFT JOIN effects e ON e.id = el.effect_id
       WHERE el.user_id=?
       ORDER BY el.created_at DESC LIMIT 50`,
      [user.uid]
    );
    return rows;
  }
}