import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { KNOWN_VARIABLES, formatReport, inspectConfig } from '../config';

/**
 * The boot gate.
 *
 * The API used to start with nothing configured. A missing JWT key is not
 * noticed until somebody signs in, and then every authenticated request
 * answers 500 — failing closed, correctly — while /health reports ok and the
 * load balancer keeps sending traffic to an instance that can serve nothing.
 *
 * Two things are worth testing here, and the second is the one that rots:
 *
 *   1. that the fatal cases are fatal and the survivable ones are not;
 *   2. that the manifest still describes every variable the code reads.
 *
 * No database and no network — this is a pure function over an environment,
 * which is the whole reason it can be checked before listening.
 */

/** A configuration that should boot cleanly. */
const ok = {
  DATABASE_URL: 'postgresql://mosaiz_app_user:pw@localhost:5433/mosaiz_mundo',
  SUPABASE_JWT_SECRET: 'a-secret',
};

describe('what must stop a deploy', () => {
  it('refuses to start with no database', () => {
    const r = inspectConfig({ SUPABASE_JWT_SECRET: 'x' } as NodeJS.ProcessEnv);
    expect(r.fatal.map((f) => f.variable)).toContain('DATABASE_URL');
  });

  it('refuses to start with no way to verify a token', () => {
    // The failure this whole file exists for: it would otherwise surface as a
    // 500 on the first sign-in, long after the deploy went green.
    const r = inspectConfig({ DATABASE_URL: ok.DATABASE_URL } as NodeJS.ProcessEnv);
    expect(r.fatal.map((f) => f.variable)).toContain(
      'SUPABASE_JWT_SECRET / SUPABASE_JWT_PUBLIC_KEY',
    );
  });

  it('accepts EITHER token key, because the algorithms are alternatives', () => {
    for (const key of ['SUPABASE_JWT_SECRET', 'SUPABASE_JWT_PUBLIC_KEY']) {
      const r = inspectConfig({
        DATABASE_URL: ok.DATABASE_URL,
        [key]: 'x',
      } as NodeJS.ProcessEnv);
      expect(r.fatal).toHaveLength(0);
    }
  });

  it('refuses a SUPERUSER database URL, which would disable every tenant boundary', () => {
    // The migrations run as postgres and the API must not: a superuser
    // bypasses RLS, so all 38 policies would simply not apply.
    const r = inspectConfig({
      ...ok,
      DATABASE_URL: 'postgresql://postgres:pw@localhost:5433/mosaiz_mundo',
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://admin.example.com',
    } as NodeJS.ProcessEnv);

    expect(r.fatal.map((f) => f.variable)).toContain('DATABASE_URL');
    expect(r.fatal.find((f) => f.variable === 'DATABASE_URL')?.message).toMatch(/row level/i);
  });

  it('allows the superuser URL OUTSIDE production, where the suites use it', () => {
    const r = inspectConfig({
      ...ok,
      DATABASE_URL: 'postgresql://postgres:pw@localhost:5433/mosaiz_mundo',
    } as NodeJS.ProcessEnv);
    expect(r.fatal).toHaveLength(0);
  });

  it('refuses production with no CORS origins, which silently blocks the admin app', () => {
    // The default is a development origin, so the symptom is a browser CORS
    // error with nothing at all in the server logs.
    const r = inspectConfig({ ...ok, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(r.fatal.map((f) => f.variable)).toContain('CORS_ORIGINS');
  });

  it('does not demand CORS origins in development', () => {
    // Otherwise every developer has to configure something to run the thing.
    expect(inspectConfig(ok as NodeJS.ProcessEnv).fatal).toHaveLength(0);
  });

  it('refuses a number that is not one', () => {
    const r = inspectConfig({ ...ok, PORT: 'eighty' } as NodeJS.ProcessEnv);
    expect(r.fatal.map((f) => f.variable)).toContain('PORT');
  });
});

describe('what must only warn', () => {
  const prod = {
    ...ok,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://admin.example.com',
  } as NodeJS.ProcessEnv;

  it('warns about a missing TRUST_PROXY without refusing to start', () => {
    // Being wrong about somebody's topology and refusing to run is worse than
    // saying so loudly.
    const r = inspectConfig(prod);
    expect(r.fatal).toHaveLength(0);
    expect(r.warnings.map((w) => w.variable)).toContain('TRUST_PROXY');
  });

  it('warns that no cache is slower, not broken', () => {
    const r = inspectConfig(prod);
    expect(r.warnings.map((w) => w.variable)).toContain('REDIS_URL');
    expect(r.enabled.cache).toBe(false);
  });

  it('says out loud that the service role key bypasses RLS', () => {
    const r = inspectConfig({ ...prod, SUPABASE_SERVICE_ROLE_KEY: 'k' });
    expect(r.warnings.find((w) => w.variable === 'SUPABASE_SERVICE_ROLE_KEY')?.message)
      .toMatch(/bypasses RLS/i);
    expect(r.fatal).toHaveLength(0);
  });

  it('flags a SUPABASE_ variable nothing reads, which is usually a typo', () => {
    const r = inspectConfig({ ...prod, SUPABASE_JWT_SECERT: 'oops' });
    expect(r.warnings.map((w) => w.variable)).toContain('SUPABASE_JWT_SECERT');
  });

  it('reports which optional capabilities this process actually has', () => {
    const r = inspectConfig({
      ...prod,
      REDIS_URL: 'redis://127.0.0.1:6379',
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    });
    expect(r.enabled).toMatchObject({ cache: true, supabaseAdmin: true, hs256: true });
    expect(formatReport(r)).toMatch(/capabilities:.*cache=on/);
  });
});

/**
 * The guard that keeps the manifest honest.
 *
 * A list of environment variables that drifts is worse than no list, because
 * it reads as authoritative. This walks the source, collects every
 * `process.env.X`, and fails if the manifest has not heard of one.
 */
describe('the manifest describes everything the code reads', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  /**
   * Comments are not reads.
   *
   * The first run of this test failed on a variable named `X`, which came from
   * the sentence in config.ts describing this very scan. That is a false
   * positive — but a useful one, since it proved the scan reaches the files it
   * claims to. Block comments and comment lines are dropped; `//` inside a
   * string (an https:// URL) is left alone, so a real read cannot be hidden.
   */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
  }

  it('has an entry for every process.env read in src/', () => {
    const root = join(__dirname, '..');
    const found = new Set<string>();

    for (const file of sourceFiles(root)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1]);
    }

    // Sanity: if the scan finds nothing, the assertion below is vacuous and
    // would pass forever against an empty manifest.
    expect(found.size).toBeGreaterThan(5);

    const undescribed = [...found].filter((v) => !(v in KNOWN_VARIABLES));
    expect(undescribed).toEqual([]);
  });
});
