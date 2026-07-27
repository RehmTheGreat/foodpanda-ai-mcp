/**
 * Structured logging to **stderr only**.
 *
 * This is a hard constraint, not a style choice: under the stdio transport,
 * stdout carries the JSON-RPC protocol stream. A single stray `console.log`
 * corrupts the stream and breaks the client connection. Everything here writes
 * to fd 2. The `no-console` ESLint rule (allow: ["error"]) enforces it repo-wide.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silent';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Never let a logging failure take down a request. */
function writeStderr(line: string): void {
  try {
    process.stderr.write(line + '\n');
  } catch {
    /* ignore */
  }
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[/token|secret|key|authorization|cookie|password/i.test(k) ? `${k}_redacted` : k] =
      /token|secret|key|authorization|cookie|password/i.test(k) ? '***' : v;
  }
  return out;
}

export function createLogger(
  level: LogLevel = 'info',
  format: 'json' | 'pretty' = 'json',
  bindings: Record<string, unknown> = {},
): Logger {
  const threshold = ORDER[level] ?? ORDER.info;

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] > threshold) return;
    const merged = { ...bindings, ...(fields ? redact(fields) : {}) };
    if (format === 'pretty') {
      const extra = Object.keys(merged).length ? ' ' + JSON.stringify(merged) : '';
      writeStderr(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`);
    } else {
      writeStderr(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...merged }));
    }
  };

  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    child: (b) => createLogger(level, format, { ...bindings, ...b }),
  };
}

/** Used by modules that have no logger injected (tests, pure helpers). */
export const nullLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => nullLogger,
};
