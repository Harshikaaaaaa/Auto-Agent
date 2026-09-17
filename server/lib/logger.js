import { createRequire } from 'module';
import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured application logger.
 *
 * JSON in production so a log shipper can parse it; pretty-printed locally only
 * if `pino-pretty` happens to be installed (it is not a dependency, so the
 * transport is attempted defensively rather than assumed).
 *
 * `redact` is the safety net that keeps credentials out of logs even when a
 * caller passes a whole request, config, or error object.
 */

const redactPaths = [
  'password',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'authorization',
  'cookie',
  'set-cookie',
  'SESSION_SECRET',
  'APP_PASSWORD',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  '*.password',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
];

function buildTransport() {
  if (env.NODE_ENV === 'production') return undefined;

  // pino resolves the transport target lazily, inside a worker, so a missing
  // module surfaces as a crash at first log rather than an import error here.
  // Resolve it up front and fall back to plain JSON when it is absent.
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } };
}

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[redacted]' },
  base: { service: 'autoagent-api' },
  transport: buildTransport(),
});
