import { CACHE_VERSION, cacheKey, invalidationPattern } from '../lib/cacheKey';

/**
 * What a cache entry is called.
 *
 * This is the whole security surface of the cache. Every read in this system is
 * filtered by RLS, so the SAME url returns DIFFERENT data depending on who
 * asked — which means a key derived from the url alone serves one restaurant's
 * data to another. The failure is invisible in any single-request test: it only
 * appears once a first request has populated the entry and a second person hits
 * it, under load, in production.
 *
 * So the rule is tested rather than trusted: no organization, no key.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('the tenant is always in the key', () => {
  it('two restaurants never share an entry', () => {
    const a = cacheKey('menu', { organizationId: ORG_A, role: 'owner' });
    const b = cacheKey('menu', { organizationId: ORG_B, role: 'owner' });

    expect(a).not.toBe(b);
    expect(a).toContain(ORG_A);
    expect(b).toContain(ORG_B);
  });

  it('two ROLES never share an entry either', () => {
    // A cashier and an owner asking the same question can legitimately get
    // different answers — the reports are gated, and RLS narrows several reads
    // by role. Sharing a key would hand one of them the other's answer.
    const owner = cacheKey('menu', { organizationId: ORG_A, role: 'owner' });
    const cashier = cacheKey('menu', { organizationId: ORG_A, role: 'cashier' });

    expect(owner).not.toBe(cashier);
  });

  it('REFUSES to build a key without an organization', () => {
    // Null, not a shorter key. A partial key is one that everybody shares.
    expect(cacheKey('menu', { organizationId: null, role: 'owner' })).toBeNull();
    expect(cacheKey('menu', { organizationId: undefined, role: 'owner' })).toBeNull();
    expect(cacheKey('menu', { organizationId: '', role: 'owner' })).toBeNull();
  });

  it('refuses to build a key without a role', () => {
    expect(cacheKey('menu', { organizationId: ORG_A, role: null })).toBeNull();
    expect(cacheKey('menu', { organizationId: ORG_A, role: '' })).toBeNull();
  });

  it('refuses an unnamed entry', () => {
    // A nameless key collides with every other nameless key.
    expect(cacheKey('', { organizationId: ORG_A, role: 'owner' })).toBeNull();
  });
});

describe('the variant', () => {
  it('separates different questions from the same person', () => {
    const july = cacheKey('trends', { organizationId: ORG_A, role: 'owner' }, 'month=07');
    const august = cacheKey('trends', { organizationId: ORG_A, role: 'owner' }, 'month=08');
    expect(july).not.toBe(august);
  });

  it('is optional, and its absence is not a collision with a variant', () => {
    const plain = cacheKey('menu', { organizationId: ORG_A, role: 'owner' });
    const varied = cacheKey('menu', { organizationId: ORG_A, role: 'owner' }, 'x');
    expect(plain).not.toBe(varied);
  });
});

describe('the version', () => {
  it('is in every key, so a shape change abandons the old entries', () => {
    // Without it, a deploy that changes a response shape serves the OLD shape
    // to every client until the last entry expires.
    expect(cacheKey('menu', { organizationId: ORG_A, role: 'owner' })).toContain(
      `:${CACHE_VERSION}:`,
    );
  });
});

describe('invalidation', () => {
  it('clears one name for one restaurant, across every role', () => {
    // A menu change changes it for everybody in that restaurant. Clearing only
    // the approver's own entry would leave every waiter reading old prices.
    const pattern = invalidationPattern('menu', ORG_A);

    expect(pattern).toContain(ORG_A);
    expect(pattern.endsWith('*')).toBe(true);
    // It must MATCH the keys it is meant to clear.
    const ownerKey = cacheKey('menu', { organizationId: ORG_A, role: 'owner' })!;
    const waiterKey = cacheKey('menu', { organizationId: ORG_A, role: 'waiter' })!;
    const prefix = pattern.slice(0, -1);
    expect(ownerKey.startsWith(prefix)).toBe(true);
    expect(waiterKey.startsWith(prefix)).toBe(true);
  });

  it('does NOT reach into another restaurant', () => {
    const pattern = invalidationPattern('menu', ORG_A);
    const otherKey = cacheKey('menu', { organizationId: ORG_B, role: 'owner' })!;
    expect(otherKey.startsWith(pattern.slice(0, -1))).toBe(false);
  });

  it('does not reach a different name in the same restaurant', () => {
    const pattern = invalidationPattern('menu', ORG_A);
    const criteria = cacheKey('criteria', { organizationId: ORG_A, role: 'owner' })!;
    expect(criteria.startsWith(pattern.slice(0, -1))).toBe(false);
  });
});

/**
 * The plan in the key (0044).
 *
 * This is not tenant isolation — that is the organization's job, above. It is
 * isolation ACROSS TIME. app.change_plan runs in the database as an operator,
 * so no request passes through this process when a tenant is downgraded and
 * there is nothing to hang an invalidation on. Naming the entries after the
 * plan means nobody goes looking for the old ones again.
 */
describe('a downgrade cannot be served out of the cache', () => {
  it('gives the same reader on two plans two different keys', () => {
    const premium = cacheKey('criteria', { organizationId: ORG_A, role: 'owner', plan: 'premium' });
    const basic = cacheKey('criteria', { organizationId: ORG_A, role: 'owner', plan: 'basic' });

    expect(premium).not.toBeNull();
    expect(premium).not.toEqual(basic);
  });

  it('treats an unknown plan as the FLOOR, never as the ceiling', () => {
    // Same rule as app.plan_rank. A caller that cannot work out the plan
    // shares a name with the cheapest tenants — reading a basic answer on a
    // premium plan is a bad afternoon; the reverse is giving the product away.
    const missing = cacheKey('criteria', { organizationId: ORG_A, role: 'owner' });
    const basic = cacheKey('criteria', { organizationId: ORG_A, role: 'owner', plan: 'basic' });
    const premium = cacheKey('criteria', { organizationId: ORG_A, role: 'owner', plan: 'premium' });

    expect(missing).toEqual(basic);
    expect(missing).not.toEqual(premium);
  });

  it('still refuses to build a key at all without an organization', () => {
    // The plan must not become a substitute for the identity.
    expect(cacheKey('criteria', { organizationId: null, role: 'owner', plan: 'premium' })).toBeNull();
    expect(cacheKey('criteria', { organizationId: ORG_A, role: null, plan: 'premium' })).toBeNull();
  });

  it('is still cleared by an explicit invalidation, on every plan it has been on', () => {
    // The plan sits inside the wildcard, so a menu change clears the tenant's
    // entries whatever tier they were computed under.
    const pattern = invalidationPattern('criteria', ORG_A);
    const prefix = pattern.slice(0, -1);

    for (const plan of ['basic', 'standard', 'premium', 'enterprise']) {
      const key = cacheKey('criteria', { organizationId: ORG_A, role: 'owner', plan })!;
      expect(key.startsWith(prefix)).toBe(true);
    }
  });

  it('does not let another restaurant in by way of the plan', () => {
    const pattern = invalidationPattern('criteria', ORG_A);
    const other = cacheKey('criteria', { organizationId: ORG_B, role: 'owner', plan: 'premium' })!;
    expect(other.startsWith(pattern.slice(0, -1))).toBe(false);
  });
});
