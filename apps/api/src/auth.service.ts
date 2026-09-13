import { Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { DbService } from './db.service';
import { config } from './config';

type TokenPayload = { sub: string; uid: number; nickname: string };

@Injectable()
export class AuthService {
  constructor(private readonly db: DbService) {}

  async createAnonymous(nickname?: string) {
    const publicId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    const safeName = (nickname || `离谱群众${Math.floor(Math.random() * 9000 + 1000)}`).slice(0, 40);
    const [result] = await this.db.pool.execute<ResultSetHeader>(
      'INSERT INTO users(public_id,nickname) VALUES(?,?)', [publicId, safeName],
    );
    const payload: TokenPayload = { sub: publicId, uid: result.insertId, nickname: safeName };
    return { token: jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' }), user: payload };
  }

  verify(token?: string): TokenPayload {
    if (!token) throw new UnauthorizedException('缺少登录凭证');
    try { return jwt.verify(token.replace(/^Bearer\s+/i, ''), config.jwtSecret) as TokenPayload; }
    catch { throw new UnauthorizedException('登录凭证无效或已过期'); }
  }

  async ensureSeedUser() {
    const rows = await this.db.rows<RowDataPacket[]>('SELECT id FROM users LIMIT 1');
    if (!rows.length) await this.createAnonymous('系统管理员');
  }
}

