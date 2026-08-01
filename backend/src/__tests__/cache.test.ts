import { cached, disconnectCache, invalidate } from '../lib/cache';

/**
 * The cache, with no Redis running.
 *
 * That is the case worth testing hardest, because it is the one that takes the
 * restaurant offline if it is wrong. Everything here can be recomputed from
 * Postgres, so an unreachable cache must be indistinguishable from a cache
 * miss — not an error, not a hang, and above all not a 500 on the till.
 *
 * REDIS_URL is deliberately left unset for this suite: a developer machine, CI,
 * and a production box with a dead cache all behave the same way, and that
 * behaviour should be the tested one.
 */

const OWNER = { organizationId: '11111111-1111-4111-8111-111111111111', role: 'owner' };

beforeEach(async () => {
  delete process.env.REDIS_URL;
  await disconnectCache();
});

afterAll(async () => {
  await disconnectCache();
});

describe('with no cache configured', () => {
  it('still answers, by producing the value', async () => {
    const value = await cached('menu', OWNER, '', 60, async () => ({ dishes: 3 }));
    expect(value).toEqual({ dishes: 3 });
  });

  it('calls the producer EVERY time — a miss, not a stale hit', async () => {
    let calls = 0;
    const produce = async () => {
      calls += 1;
      return calls;
    };

    expect(await cached('menu', OWNER, '', 60, produce)).toBe(1);
    expect(await cached('menu', OWNER, '', 60, produce)).toBe(2);
  });

  it('invalidating is a no-op rather than a crash', async () => {
    await expect(invalidate('menu', OWNER.organizationId)).resolves.toBeUndefined();
  });

  it('lets the producer\'s own error through', async () => {
    // The cache must not swallow a real failure. A database that is down should
    // surface as a database error, not as an empty answer.
    await expect(
      cached('menu', OWNER, '', 60, async () => {
        throw new Error('database is down');
      }),
    ).rejects.toThrow('database is down');
  });
});

describe('without an identity', () => {
  it('produces without caching when there is no organization', async () => {
    let calls = 0;
    const produce = async () => {
      calls += 1;
      return calls;
    };

    // An unauthenticated or org-less request must never share an entry with
    // somebody. Twice through means twice produced.
    await cached('menu', { organizationId: null, role: 'owner' }, '', 60, produce);
    await cached('menu', { organizationId: null, role: 'owner' }, '', 60, produce);
    expect(calls).toBe(2);
  });

  it('produces without caching when there is no role', async () => {
    const value = await cached(
      'menu',
      { organizationId: OWNER.organizationId, role: null },
      '',
      60,
      async () => 'fresh',
    );
    expect(value).toBe('fresh');
  });
});

describe('with an unreachable Redis', () => {
  it('does not hang, and does not fail the request', async () => {
    // Pointed at a port nothing is listening on. The connect and command
    // timeouts are what keep this from becoming a stalled request.
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';
    await disconnectCache();

    const started = Date.now();
    const value = await cached('menu', OWNER, '', 60, async () => 'from the database');
    const elapsed = Date.now() - started;

    expect(value).toBe('from the database');
    // Generous, but it proves the request is not waiting on a retry loop.
    expect(elapsed).toBeLessThan(3000);
  });
});
