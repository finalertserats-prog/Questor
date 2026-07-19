import pino from 'pino';
import { config } from './config.js';

// Plain pino (structured JSON) — no pino-pretty dependency required so the
// server runs with zero extra installs. Set LOG_LEVEL to override.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.nodeEnv === 'test' ? 'silent' : 'info'),
});
