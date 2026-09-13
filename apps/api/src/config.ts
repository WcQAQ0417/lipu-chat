export const config = {
  port: Number(process.env.PORT || 3000),
  webOrigin: process.env.PUBLIC_WEB_ORIGIN || 'http://localhost:8080',
  jwtSecret: process.env.JWT_ACCESS_SECRET || 'dev-only-change-me',
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE || 'lipu_chat',
    user: process.env.MYSQL_USER || 'lipu',
    password: process.env.MYSQL_PASSWORD || 'lipu_dev_password',
  },
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  redisPassword: process.env.REDIS_PASSWORD || 'lipu_redis_dev_password',
  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 12000),
    mock: process.env.LLM_MOCK_MODE === 'true' || !process.env.LLM_API_KEY,
  },
  tokendance: {
    apiKey: process.env.TOKENDANCE_API_KEY || '',
    imageModel: process.env.TOKENDANCE_IMAGE_MODEL || 'seedream-5.0-lite',
    videoModel: process.env.TOKENDANCE_VIDEO_MODEL || 'kling-3.0',
    baseUrl: 'https://tokendance.space/gateway/v1',
    enabled: !!process.env.TOKENDANCE_API_KEY,
  },
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  roomEmptyTtlSeconds: Number(process.env.ROOM_EMPTY_TTL_SECONDS || 300),
};

