/**
 * What a cache entry is called.
 *
 * Separated from the cache itself, with no Redis in it, because this is the
 * part that can leak data between restaurants and it should be testable without
 * a server running.
 *
 * THE RULE: a key ALWAYS carries the organization and the role.
 *
 * Every read in this system is filtered by RLS, which means the SAME url
 * returns DIFFERENT data depending on who asked. A key derived from the url
 * alone would let one restaurant's menu be served to another, or a cashier read
 * an answer computed for an owner — and it would do it silently, only under
 * load, only once the first request had populated the entry. There is no test
 * of a single request that catches it.
 *
 * So the key is built by a function that cannot be called without both, and
 * `cacheKey` returns null rather than a partial key when either is missing.
 * A missing identity means "do not cache", never "cache under a shorter name".
 *
 * SINCE 0044 THE KEY ALSO CARRIES THE PLAN, and that one is not about leaking
 * between tenants — it is about leaking through time. A plan is changed by
 * app.change_plan, which runs in the DATABASE as an operator; no request comes
 * through this process, so there is no hook on which to invalidate anything.
 * A downgraded tenant would keep being served the answers it paid for until
 * every TTL happened to expire. Folding the plan into the name means the old
 * entries are not invalidated so much as ABANDONED — nothing goes looking for
 * them again, which is the only invalidation available when the event that
 * should trigger it never reaches this process.
 */

/** Bumped by hand to abandon every existing entry after a shape change. */
export const CACHE_VERSION = 'v1';

export interface CacheIdentity {
  organizationId: string | null | undefined;
  role: string | null | undefined;
  /**
   * Absent is allowed and means `basic` — the same fail-closed floor
   * app.plan_rank applies. A caller that cannot determine the plan shares a
   * name with the cheapest tenants, never with the most expensive ones.
   */
  plan?: string | null;
}

/**
 * The full key, or null when this request must not be cached at all.
 *
 * `variant` is anything that changes the ANSWER for the same person — a query
 * string, a month, a filter. It is appended verbatim, so a caller that forgets
 * to include a parameter gets a wrong answer for the same reason a caller that
 * forgets the organization does. Both are the caller's to get right; only one
 * of them is a security problem, which is why only one is enforced here.
 */
export function cacheKey(
  name: string,
  identity: CacheIdentity,
  variant = '',
): string | null {
  const { organizationId, role, plan } = identity;

  // No identity, no cache. An unauthenticated or org-less request is served
  // from the database every time rather than sharing an entry with somebody.
  if (!organizationId || !role) return null;
  if (!name) return null;

  const parts = ['mm', CACHE_VERSION, name, organizationId, plan || 'basic', role];
  if (variant) parts.push(variant);
  return parts.join(':');
}

/**
 * The pattern that matches every entry for one name in one organization,
 * across all roles.
 *
 * Used to invalidate: when the menu changes, it changes for everybody in that
 * restaurant, and an invalidation that only cleared the approver's own entry
 * would leave every waiter reading yesterday's prices.
 */
export function invalidationPattern(name: string, organizationId: string): string {
  // Still a prefix match, and the plan sits inside the wildcard — so an
  // explicit invalidation clears the tenant's entries on EVERY plan they have
  // been on, not just the current one.
  return `mm:${CACHE_VERSION}:${name}:${organizationId}:*`;
}
