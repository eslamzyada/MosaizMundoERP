/**
 * Structured logging, so that a failure at 9pm on a Friday can be found.
 *
 * WHAT WAS THERE BEFORE.
 *
 * 121 ad-hoc `console.*` calls and no request logging whatsoever. The
 * centralized error handler was the sharpest edge:
 *
 *     console.error(err);
 *     res.status(500).json({ error: 'Internal server error' });
 *
 * A raw stack trace, with no path, no user, no organization, and nothing tying
 * it to the person who hit it. A cashier says "it failed around 8:40" and
 * there is no way to find which line is theirs — or whether their failure is
 * even in the file.
 *
 * ----------------------------------------------------------------------------
 * WHY AN ALLOWLIST, AND NOT A REDACTION LIST.
 *
 * The dangerous version of this file is the one that logs "the request" and
 * then removes the bits that are sensitive. That is backwards: it fails OPEN.
 * Every new header, field or property is logged by default, and stays logged
 * until somebody notices. `Authorization: Bearer <token>` is one careless
 * `req.headers` away from sitting in a log aggregator forever, and a bearer
 * token in a log is a credential in a log.
 *
 * So nothing is logged unless it is named. There is no code path here that
 * serializes a whole request, a whole header set, or a request body.
 *
 * Deliberately NOT logged, in any mode:
 *
 *   * headers — all of them, including Authorization and Cookie;
 *   * request and response bodies — they carry prices, names and PINs;
 *   * query strings — `req.path` is logged, never `req.originalUrl`, because
 *     a query string is exactly where a stray identifier ends up.
 *
 * Path segments DO include record UUIDs (`/api/orders/<uuid>`). That is the
 * point of having the log at all, and a UUID is not personal data.
 *
 * ----------------------------------------------------------------------------
 * NO DEPENDENCY. This is ~100 lines and the whole contract is visible in one
 * file; pino would be a dependency, a transport, and a redaction config to get
 * wrong. JSON Lines on stdout is what every aggregator already reads, and in a
 * container stdout IS the log.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Anything a log line may carry. Values are named by the caller, never scraped. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Where lines go. Swappable so the tests can read what was written. */
export type Sink = (line: string) => void;

/**
 * Under test the default sink DISCARDS.
 *
 * Otherwise every supertest request in ~700 tests writes a line straight to
 * stdout, interleaved with the reporter, and a CI log nobody can read is a CI
 * log nobody reads. The same reasoning the rate limiter already uses
 * (`skip: () => NODE_ENV === 'test'` in app.ts).
 *
 * This does not weaken the logging tests: they pass their own sink to
 * configureLogger and assert on what it received, so the behaviour under test
 * is the real one — only the destination differs.
 */
function defaultSink(line: string): void {
  if (process.env.NODE_ENV === 'test') return;
  process.stdout.write(`${line}\n`);
}

let sink: Sink = defaultSink;
/**
 * An unrecognised LOG_LEVEL must not decide anything by accident.
 *
 * Taking `process.env.LOG_LEVEL` as a level directly, a value like "verbose"
 * gives `LEVEL_RANK[level] === undefined`; every `<` comparison against it is
 * NaN and therefore false, so the filter passes EVERYTHING. The opposite slip
 * — a typo that silences the log — would be worse. Fall back to info, and let
 * config.ts warn about it at boot.
 */
function parseLevel(raw: string | undefined): LogLevel {
  return raw && raw in LEVEL_RANK ? (raw as LogLevel) : 'info';
}

let minimum: LogLevel = parseLevel(process.env.LOG_LEVEL);
let pretty = process.env.NODE_ENV !== 'production';

/** For tests, and for a deployment that wants JSON locally. */
export function configureLogger(options: { sink?: Sink; level?: LogLevel; pretty?: boolean }): void {
  if (options.sink) sink = options.sink;
  if (options.level) minimum = options.level;
  if (options.pretty !== undefined) pretty = options.pretty;
}

export function resetLogger(): void {
  sink = defaultSink;
  minimum = parseLevel(process.env.LOG_LEVEL);
  pretty = process.env.NODE_ENV !== 'production';
}

/**
 * An Error is not JSON-serializable — `JSON.stringify(new Error('x'))` is
 * `{}`, which is how a stack trace silently becomes an empty object in a log.
 * Named fields, taken deliberately.
 */
function describeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: err.message,
      // The stack is the reason anyone reads this line. It names our own files
      // and library frames — no request data passes through it.
      error_stack: err.stack,
      // Prisma and Postgres both put the useful discriminator on `code`.
      error_code: (err as { code?: string }).code,
    };
  }
  return { error_message: String(err) };
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minimum]) return;

  const record: LogFields = {
    time: new Date().toISOString(),
    level,
    message,
    ...fields,
  };

  // Drop undefined rather than emitting `"user_id": null` on every anonymous
  // request — a field that is absent reads as "not applicable", which is true.
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }

  if (!pretty) {
    sink(JSON.stringify(record));
    return;
  }

  // Development: a terminal, not an aggregator. Same fields, readable.
  const { time, level: _l, message: msg, error_stack, ...rest } = record;
  const extras = Object.entries(rest)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  sink(
    `${String(time).slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${msg}` +
      `${extras ? `  ${extras}` : ''}${error_stack ? `\n${error_stack}` : ''}`,
  );
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, err?: unknown, fields?: LogFields) =>
    emit('error', message, { ...fields, ...(err === undefined ? {} : describeError(err)) }),
};
