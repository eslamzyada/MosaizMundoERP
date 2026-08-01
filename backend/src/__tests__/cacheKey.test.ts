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
