/**
 * Minimal structured logger that prefers Strapi's logger when available and
 * falls back to the console. It never serializes credentials or signed tokens —
 * callers pass only object keys, counts and provider names.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

interface StrapiLike {
  log?: Record<Level, (msg: string, ...args: unknown[]) => void>;
}

declare const strapi: StrapiLike | undefined;

const PREFIX = '[upload-multi-cloud]';

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${PREFIX} ${msg} ${safeJson(meta)}` : `${PREFIX} ${msg}`;
  const s = typeof strapi !== 'undefined' ? strapi : undefined;
  if (s?.log?.[level]) {
    s.log[level](line);
    return;
  }
  // eslint-disable-next-line no-console
  (console[level] ?? console.log)(line);
}

/** JSON stringify that drops anything that looks secret, defensively. */
function safeJson(meta: Record<string, unknown>): string {
  const SECRET = /(key|secret|token|password|sas|signature|credential)/i;
  try {
    return JSON.stringify(meta, (k, v) => (SECRET.test(k) ? '[redacted]' : v));
  } catch {
    return '[unserializable]';
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
