import 'dotenv/config';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../prisma';

// Transport-level hardening from the system analysis (F-06/F-07/F-08). These
// need no auth or database — they assert what the app exposes to any caller.

afterAll(async () => {
  await prisma.$disconnect();
});

describe('API hardening', () => {
  test('security headers are set and x-powered-by is removed (F-06)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    // helmet: content-type sniffing off, framing off, Express fingerprint gone.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('CORS reflects an allowed origin and withholds the header from others (F-07)', async () => {
    // CORS_ORIGINS defaults to http://localhost:5173 when unset.
    const allowed = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(app).get('/health').set('Origin', 'https://evil.example');
    // No Access-Control-Allow-Origin header → the browser blocks the read.
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('the correlation id is READABLE by the admin app, not just present', async () => {
    /**
     * Setting the header is necessary and not sufficient. A browser only lets
     * script read a handful of safelisted response headers; anything else is
     * invisible cross-origin unless the server names it in
     * Access-Control-Expose-Headers. Without that, the id is on the wire and
     * visible in devtools while being `undefined` to the code meant to show it
     * — a failure with no symptom at all.
     */
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');

    expect(res.headers['x-request-id']).toBeDefined();
    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain(
      'x-request-id',
    );
  });

  test('a request with no Origin (POS / curl / webhook) is not blocked (F-07)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  test('the /test-auth debug endpoint is gone (F-08)', async () => {
    const res = await request(app).get('/test-auth');
    expect(res.status).toBe(404);
  });
});

/**
 * Liveness and readiness are DIFFERENT QUESTIONS, and the difference decides
 * what an orchestrator does about a bad answer.
 *
 *   /health  — "is this process running?"    → a bad answer means RESTART
 *   /ready   — "can it serve a request?"     → a bad answer means STOP ROUTING
 *
 * Conflating them is how a database outage becomes a restart loop across every
 * instance, over something no restart can fix. So /health must NOT touch the
 * database, and /ready must.
 *
 * Verified out-of-process as well, against an instance pointed at a dead
 * database: /health answered 200 while /ready answered 503.
 */
describe('liveness and readiness', () => {
  test('/ready reports the database it just reached', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', database: 'reachable' });
  });

  test('/health answers without any database access at all', async () => {
    // The point of liveness. Asserted by making every query fail: if /health
    // touched the database this would throw, and the restart loop described
    // above is exactly what would follow in production.
    const spy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValue(new Error('database is down'));
    try {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('/ready answers 503 — not 500 — when the database is unreachable', async () => {
    // 503 is the honest code: this instance is temporarily unable to serve, a
    // state a load balancer routes around rather than an error to report.
    const spy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValue(new Error('database is down'));
    try {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'not_ready', database: 'unreachable' });
    } finally {
      spy.mockRestore();
    }
  });
});
