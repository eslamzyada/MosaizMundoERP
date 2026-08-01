import { withPoolDefaults } from '../prisma';

/**
 * The connection pool is the concurrency ceiling.
 *
 * Under one-transaction-per-request a connection is held for the whole life of
 * a request, so pool size IS the number of requests that can be served at once.
 * Leaving it at Prisma's default means the ceiling changes when the machine
 * changes, and nobody ever decided what it was.
 */

describe('withPoolDefaults', () => {
  it('sets a ceiling when the URL does not', () => {
    const out = new URL(withPoolDefaults('postgresql://u:p@localhost:5433/db')!);
    expect(out.searchParams.get('connection_limit')).toBe('20');
    expect(out.searchParams.get('pool_timeout')).toBe('10');
  });

  it('does NOT overrule an operator who has already tuned it', () => {
    const out = new URL(
      withPoolDefaults('postgresql://u:p@localhost:5433/db?connection_limit=50')!,
    );
    expect(out.searchParams.get('connection_limit')).toBe('50');
    // …and still fills in the one they did not set.
    expect(out.searchParams.get('pool_timeout')).toBe('10');
  });

  it('keeps every other parameter untouched', () => {
    const out = new URL(
      withPoolDefaults('postgresql://u:p@localhost:5433/db?schema=public&sslmode=require')!,
    );
    expect(out.searchParams.get('schema')).toBe('public');
    expect(out.searchParams.get('sslmode')).toBe('require');
  });

  it('preserves the credentials it was given', () => {
    // Mangling these would be a connection failure at boot with a confusing
    // cause, so it is worth an assertion.
    const out = new URL(withPoolDefaults('postgresql://user:s3cr3t@host:5433/db')!);
    expect(out.username).toBe('user');
    expect(out.password).toBe('s3cr3t');
    expect(out.port).toBe('5433');
  });

  it('passes an unparseable URL straight through', () => {
    // Prisma's own error is better than anything invented here.
    expect(withPoolDefaults('not a url')).toBe('not a url');
  });

  it('leaves an absent URL absent', () => {
    expect(withPoolDefaults(undefined)).toBeUndefined();
  });
});
