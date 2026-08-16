import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { configureLogger, logger, resetLogger } from '../lib/logger';
import { requestContext } from '../middleware/requestLog';
import { errorHandler } from '../app';

/**
 * The log is a place secrets go to live forever.
 *
 * A bearer token written into an aggregator is a credential in a system with
 * different access rules, a longer retention period and no rotation story. So
 * the tests that matter most here are not "does it log?" — they are "can this
 * ever log the one thing it must not?", and they are written against a real
 * Express app carrying a real Authorization header.
 *
 * The apps here are built per test rather than mounting the whole application,
 * so these assert the MIDDLEWARE's behaviour and not the particular route table
 * the API happens to have today. The error handler is the exception: it is
 * imported from ../app, because a copy of it would keep passing after somebody
 * changed the one that ships.
 */

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  configureLogger({ sink: (line) => lines.push(line), level: 'debug', pretty: false });
});

afterEach(() => {
  resetLogger();
});

/** Every line, parsed. Also asserts the output really is JSON Lines. */
function records(): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line));
}

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
  app.get('/ready', (_req: Request, res: Response) => res.json({ status: 'ready' }));
  app.get('/api/thing', (_req: Request, res: Response) => res.json({ ok: true }));
  app.get('/api/missing', (_req: Request, res: Response) => res.status(404).json({}));
  app.get('/api/secret-in-query', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

describe('what must never reach the log', () => {
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-payload.and-its-signature';

  it('never writes the Authorization header, even though it was sent', async () => {
    await request(buildApp())
      .get('/api/thing')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Cookie', 'session=a-cookie-value');

    // The whole output, not one field: a leak anywhere counts.
    const everything = lines.join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('Bearer');
    expect(everything).not.toContain('a-cookie-value');

    // Counterfactual: the request WAS logged, so the assertion above is not
    // passing merely because nothing happened.
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ message: 'request', path: '/api/thing' });
  });

  it('logs the path the CLIENT asked for, not the one the router sees', async () => {
    /**
     * Found by running the thing, not by reading it.
     *
     * Express rewrites `req.url` when it hands a request to a mounted router,
     * so a handler under `/api/me` sees `req.path === '/'`. The completion line
     * is written from `res.on('finish')`, by which point the rewrite has
     * happened — so every single /api route logged `"path":"/"`, which is
     * exactly no help at 9pm.
     *
     * Asserted through a real mounted router, because an app-level route would
     * pass either way and prove nothing.
     */
    const app = express();
    app.use(requestContext);
    const router = express.Router();
    router.get('/', (_req: Request, res: Response) => res.status(401).json({}));
    app.use('/api/me', router);

    await request(app).get('/api/me');

    expect(records()[0].path).toBe('/api/me');
  });

  it('logs the path but never the query string', async () => {
    await request(buildApp()).get('/api/secret-in-query?token=leaked&email=a@b.c');

    const everything = lines.join('\n');
    expect(everything).not.toContain('leaked');
    expect(everything).not.toContain('a@b.c');
    expect(records()[0]).toMatchObject({ path: '/api/secret-in-query' });
  });

  it('records an address only on a failure, never on a success', async () => {
    // An address is personal data. There is no operational reason to keep one
    // for every successful menu load, and every reason to have it for the
    // request that failed.
    await request(buildApp()).get('/api/thing');
    expect(records()[0].ip).toBeUndefined();

    lines = [];
    await request(buildApp()).get('/api/missing');
    expect(records()[0].ip).toBeDefined();
  });
});

describe('the correlation id', () => {
  it('is generated, echoed to the caller, and matches the logged line', async () => {
    const res = await request(buildApp()).get('/api/thing');

    const header = res.headers['x-request-id'];
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(records()[0].request_id).toBe(header);
  });

  it('adopts a proxy-supplied id, so one trace spans both hops', async () => {
    const res = await request(buildApp())
      .get('/api/thing')
      .set('x-request-id', 'edge-7f3a9c21');

    expect(res.headers['x-request-id']).toBe('edge-7f3a9c21');
    expect(records()[0].request_id).toBe('edge-7f3a9c21');
  });

  it('refuses an id that would inject a second line into the log', () => {
    // Untrusted input that lands in a log file. A newline here writes a line
    // the aggregator cannot distinguish from a real event — it could be shaped
    // to read as a successful sign-in among genuine ones.
    //
    // Driven against the middleware directly, NOT through supertest: Node's
    // HTTP client refuses to send a header containing a newline at all
    // ("Invalid character in header content"), so an HTTP-level test would
    // assert the client's validation and prove nothing about ours. Node's
    // server rejects such headers too — this guard is the layer that does not
    // depend on either of them still doing so.
    const forged = 'abc\n{"level":"info","message":"auth succeeded","user_id":"attacker"}';

    const req = {
      get: (name: string) => (name === 'x-request-id' ? forged : undefined),
      path: '/api/thing',
      method: 'GET',
      ip: '10.0.0.1',
    } as unknown as Request;

    const headers: Record<string, unknown> = {};
    const res = {
      setHeader: (k: string, v: unknown) => {
        headers[k] = v;
      },
      on: () => undefined,
      statusCode: 200,
    } as unknown as Response;

    requestContext(req, res, () => undefined);

    expect(req.requestId).not.toContain('\n');
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['x-request-id']).toBe(req.requestId);
  });

  it('keeps an id that is merely unusual but safe', () => {
    // The guard must not be so strict that a real tracing id is discarded —
    // that would break correlation across the proxy, which is the whole point.
    const supplied = 'trace-1a2b_3c.4d';
    const req = {
      get: () => supplied,
      path: '/api/thing',
      method: 'GET',
    } as unknown as Request;
    const res = { setHeader: () => undefined, on: () => undefined } as unknown as Response;

    requestContext(req, res, () => undefined);
    expect(req.requestId).toBe(supplied);
  });

  it('refuses an absurdly long id', async () => {
    const res = await request(buildApp())
      .get('/api/thing')
      .set('x-request-id', 'x'.repeat(5000));

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('what must not drown the log', () => {
  it('does not log the liveness and readiness probes', async () => {
    // An orchestrator hits these every few seconds. Logged, they would be
    // almost the entire file, and the one line somebody needs would be buried.
    await request(buildApp()).get('/health');
    await request(buildApp()).get('/ready');
    expect(lines).toHaveLength(0);

    // But they still get an id, because a probe that fails is worth tracing.
    const res = await request(buildApp()).get('/ready');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

/**
 * The convention guard.
 *
 * One `console.error` added to a controller is invisible in review and breaks
 * two things quietly: the line is not JSON, so an aggregator parsing this
 * stream gets a stray, and it carries no request id, so the failure it reports
 * cannot be tied to the person who hit it. Both failures look like nothing at
 * all until somebody is trying to answer a question at 9pm.
 */
describe('nothing writes to the console directly', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  it('leaves console.* only where the logger cannot be used yet', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];

    for (const file of sourceFiles(root)) {
      const unix = file.replace(/\\/g, '/');
      // Three exemptions, and the first is the one with a reason worth stating:
      //
      //   boot.ts and server.ts must print REGARDLESS OF LOG_LEVEL. The boot
      //   report says what configuration the process came up with and why it
      //   is refusing to start; "listening on 3000" and "shutdown complete"
      //   bracket its life. Routed through the logger, `LOG_LEVEL=error` would
      //   silently hide all of it — and an operator who tightened the level to
      //   cut noise would lose exactly the lines they need when the thing will
      //   not start.
      //
      //   __tests__ is not shipped, and lib/logger.ts IS the console writer.
      if (
        unix.includes('/__tests__/') ||
        unix.endsWith('/boot.ts') ||
        unix.endsWith('/server.ts') ||
        unix.endsWith('/lib/logger.ts')
      ) {
        continue;
      }

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Ignore prose: several comments quote the old code on purpose.
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line)) {
            offenders.push(`${unix.split('/src/')[1]}:${i + 1}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });
});

describe('a 500 gives the caller something to quote', () => {
  /**
   * Uses the REAL handler exported from app.ts, not a copy — a copy would keep
   * passing after somebody changed the one that ships.
   */
  function appThatThrows() {
    const app = express();
    app.use(requestContext);
    app.get('/api/boom', () => {
      throw new Error('the constraint orders_total_check was violated');
    });
    app.use(errorHandler);
    return app;
  }

  it('returns the same id it logged, so the two can be joined', async () => {
    const res = await request(appThatThrows()).get('/api/boom');

    expect(res.status).toBe(500);
    expect(res.body.request_id).toBe(res.headers['x-request-id']);

    const failure = records().find((r) => r.message === 'unhandled error');
    expect(failure).toBeDefined();
    // The whole point: the id on the cashier's screen finds exactly this line.
    expect(failure?.request_id).toBe(res.body.request_id);
    expect(failure?.path).toBe('/api/boom');
  });

  it('keeps the internal detail in the log and out of the response', async () => {
    // An internal error can quote a constraint name, a column, or part of a
    // query. That belongs in the log, never in a response to a till.
    const res = await request(appThatThrows()).get('/api/boom');

    expect(JSON.stringify(res.body)).not.toContain('orders_total_check');
    expect(res.body.error).toBe('Internal server error');

    const failure = records().find((r) => r.message === 'unhandled error');
    expect(String(failure?.error_message)).toContain('orders_total_check');
    expect(String(failure?.error_stack)).toContain('logging.test.ts');
  });
});

describe('the shape of a line', () => {
  it('is one JSON object per line, with a timestamp and a level', async () => {
    await request(buildApp()).get('/api/thing');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(records()[0]).toMatchObject({ level: 'info', message: 'request', status: 200 });
    expect(String(records()[0].time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof records()[0].duration_ms).toBe('number');
  });

  it('serializes an Error instead of writing {}', () => {
    // JSON.stringify(new Error('x')) is '{}' — which is how a stack trace
    // silently becomes an empty object and the log looks fine while saying
    // nothing at all.
    logger.error('it broke', new Error('the actual reason'));

    const rec = records()[0];
    expect(rec.error_message).toBe('the actual reason');
    expect(String(rec.error_stack)).toContain('logging.test.ts');
    expect(JSON.stringify(rec)).not.toBe('{}');
  });

  it('omits a field that has no value rather than writing null', async () => {
    await request(buildApp()).get('/api/thing');
    // Anonymous request: "not applicable" is honest, `"user_id": null` is noise
    // on every public menu read.
    expect(records()[0]).not.toHaveProperty('user_id');
  });

  it('honours the level, and falls back to info on a value it does not know', () => {
    configureLogger({ level: 'warn' });
    logger.info('should not appear');
    logger.warn('should appear');
    expect(lines).toHaveLength(1);

    // The dangerous mistake: an unrecognised level makes every rank comparison
    // NaN, so the filter passes everything — or, worse, silences it.
    lines = [];
    process.env.LOG_LEVEL = 'verbose';
    try {
      resetLogger();
      configureLogger({ sink: (line) => lines.push(line), pretty: false });
      logger.debug('below info, must be dropped');
      logger.info('at info, must appear');
      expect(lines).toHaveLength(1);
      expect(records()[0].message).toBe('at info, must appear');
    } finally {
      delete process.env.LOG_LEVEL;
    }
  });
});
