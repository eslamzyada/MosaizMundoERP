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

  test('a request with no Origin (POS / curl / webhook) is not blocked (F-07)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  test('the /test-auth debug endpoint is gone (F-08)', async () => {
    const res = await request(app).get('/test-auth');
    expect(res.status).toBe(404);
  });
});
