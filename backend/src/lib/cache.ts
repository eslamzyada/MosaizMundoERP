import Redis from 'ioredis';
import { Request } from 'express';
import { cacheKey, invalidationPattern } from './cacheKey';

/**
 * A cache that is allowed to be absent.
 *
 * WHY IT DEGRADES INSTEAD OF FAILING.
 *
 * Redis is an optimisation here, not a store of record — everything in it can
 * be recomputed from Postgres. So every operation swallows its own errors and
 * falls through to the database. A cache that takes the restaurant offline when
 * it is unreachable is strictly worse than no cache at all, and "the till
 * stopped selling because a cache was down" is not a sentence anybody should
 * have to say.
 *
 * WHAT IS NOT CACHED, DELIBERATELY.
 *
 * Anything money-shaped: profitability, trends, purchasing, waste, exports.
 * Those are the slowest reads and the most tempting, and they are exactly the
 * ones where a stale number changes a decision. A menu that is thirty seconds
 * out of date is a cosmetic problem; a margin that is thirty seconds out of
 * date is somebody re-pricing a dish on it.
 */

let client: Redis | null = null;
let attempted = false;
/** Flipped once, so a missing Redis does not log on every request. */
let warned = false;

/** How long an entry lives. Short: correctness beats hit rate here. */
export const DEFAULT_TTL_SECONDS = 60;

function connect(): Redis | null {
  if (attempted) return client;
  attempted = true;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    client = new Redis(url, {
      // One attempt, short timeout, no queue: a request must not sit waiting
      // for a cache. If Redis is not there, the database answers.
      connectTimeout: 500,
      commandTimeout: 300,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });

    client.on('error', () => {
      if (!warned) {
        warned = true;
        // eslint-disable-next-line no-console
        console.warn('[cache] Redis unreachable — serving everything from the database');
      }
    });
  } catch {
    client = null;
  }
  return client;
}

/** For tests and shutdown. */
export async function disconnectCache(): Promise<void> {
  if (client) {
    client.disconnect();
    client = null;
  }
  attempted = false;
  warned = false;
}

/** The identity a key is built from. Read from the request, never from a body. */
export interface CacheContext {
  organizationId: string | null;
  role: string | null;
  /** The plan, so an entry cannot outlive the entitlement that produced it. */
  plan?: string | null;
}

/**
 * Runs `produce`, caching its result under a key that carries the caller's
 * organization and role.
 *
 * Returns the produced value either way — a cache miss, a Redis outage and a
 * serialisation failure are all the same thing to the caller.
 */
export async function cached<T>(
  name: string,
  ctx: CacheContext,
  variant: string,
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<T> {
  const key = cacheKey(name, ctx, variant);
  const redis = key ? connect() : null;

  if (!redis || !key) return produce();

  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    // Unreachable, timed out, or unparseable. Fall through and recompute.
  }

  const value = await produce();

  try {
    // Fire and forget would lose the error; awaiting a 300ms-capped SET costs
    // less than debugging a cache that silently never populates.
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // The answer is already computed; failing to remember it is not an error
    // the caller needs to hear about.
  }

  return value;
}

/**
 * Forgets every entry for one name in one organization, across all roles.
 *
 * Called when the underlying thing changes. Uses SCAN rather than KEYS: KEYS
 * blocks the whole server while it walks the keyspace, which on a shared Redis
 * is a way to make one restaurant's menu edit everybody else's outage.
 */
export async function invalidate(name: string, organizationId: string): Promise<void> {
  const redis = connect();
  if (!redis || !organizationId) return;

  const pattern = invalidationPattern(name, organizationId);
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {
    // If the cache cannot be cleared, the entries expire on their own within
    // DEFAULT_TTL_SECONDS. Short TTLs are what make that acceptable.
  }
}

/**
 * The caller's identity, for a key.
 *
 * `req.userId` is bound by the auth middleware from a VERIFIED token, and the
 * role is resolved the same way requireRole resolves it, so a key can never be
 * influenced by anything the client sent.
 */
export async function contextFor(req: Request): Promise<CacheContext> {
  if (!req.tx || !req.userId) return { organizationId: null, role: null };

  const membership = await req.tx.organization_memberships.findFirst({
    where: { user_id: req.userId, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true, role: true },
  });

  if (!membership) return { organizationId: null, role: null };

  // One primary-key lookup, on a request that was about to hit Redis anyway.
  // It is the price of a cache that cannot outlive a downgrade, and it is
  // cheaper than the alternative — which is a tenant reading premium answers
  // for a minute after they stopped paying for them.
  const org = await req.tx.organizations.findUnique({
    where: { id: membership.organization_id },
    select: { plan_tier: true },
  });

  return {
    organizationId: membership.organization_id,
    role: membership.role,
    plan: org?.plan_tier ?? 'basic',
  };
}
