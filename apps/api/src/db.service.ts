import { Injectable, OnModuleDestroy } from '@nestjs/common';
import mysql, { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { config } from './config';

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool = mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    connectionLimit: 12,
    charset: 'utf8mb4',
    timezone: '+08:00',
  });

  async rows<T extends RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
    const [rows] = await this.pool.query<T>(sql, params);
    return rows;
  }

  async transaction<T>(callback: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async onModuleDestroy() { await this.pool.end(); }
}

