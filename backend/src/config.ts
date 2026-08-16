/**
 * Every environment variable this API reads, in one place, checked once at boot.
 *
 * WHY THIS EXISTS.
 *
 * Until now the API started happily with nothing configured. A missing
 * SUPABASE_JWT_SECRET is not detected until somebody signs in, and then every
 * authenticated request answers 500 — correctly, failing closed, but the
 * operator finds out from a user rather than from the deploy. `/health` says
 * "ok" the whole time, because liveness never touched any of it, so the load
 * balancer keeps sending traffic to an instance that cannot serve a single
 * request.
 *
 * The same shape as the rest of this codebase: a gap you can SEE is
 * survivable, a gap that looks like health is not.
 *
 * ----------------------------------------------------------------------------
 * FATAL vs WARNING, and why the line is where it is.
 *
 * FATAL is reserved for a configuration that CANNOT serve traffic — no
 * database, or no way to verify a token. Refusing to start is kinder than
 * starting: a deploy that fails is rolled back automatically, while a deploy
 * that starts and 500s is an outage somebody has to diagnose.
 *
 * WARNING is for a configuration that works but is probably not what was
 * meant in production. These do not stop the boot, because being wrong about
 * somebody's topology and refusing to run is worse than saying so loudly.
 *
 * ----------------------------------------------------------------------------
 * This module deliberately does NOT run on import of `app.ts`. The tests
 * import the app and build their own environment; making the app unimportable
 * without a full production configuration would mean every suite carries
 * config it does not use. The gate belongs at the boot edge — server.ts.
 */

export interface ConfigProblem {
  variable: string;
  message: string;
}

export interface ConfigReport {
  fatal: ConfigProblem[];
  warnings: ConfigProblem[];
  /** Optional capabilities, and whether this process actually has them. */
  enabled: Record<string, boolean>;
}

/**
 * Every variable read anywhere in src/, with why it is read.
 *
 * Kept complete by a test that greps the source for `process.env.X` and fails
 * if anything is missing here — a manifest that drifts is worse than none,
 * because it reads as authoritative.
 */
export const KNOWN_VARIABLES: Record<string, string> = {
  DATABASE_URL: 'The application connection, as mosaiz_app_user. Required.',
  ADMIN_DATABASE_URL: 'Superuser connection, used ONLY by the test suites.',
  SUPABASE_JWT_SECRET: 'HS256 secret for verifying Supabase tokens.',
  SUPABASE_JWT_PUBLIC_KEY: 'ES256 public key (PEM) for verifying Supabase tokens.',
  SUPABASE_URL: 'Supabase project URL, for the admin-side user lookups.',
  SUPABASE_SERVICE_ROLE_KEY: 'Bypasses RLS. Server-side only, never to a browser.',
  SUPABASE_WEBHOOK_SECRET: 'HMAC secret for the Supabase user webhook.',
  CORS_ORIGINS: 'Comma-separated browser origins allowed to read responses.',
  RATE_LIMIT_MAX: 'Per-IP request ceiling for the authenticated API.',
  PUBLIC_ORDER_RATE_LIMIT: 'Per-IP ceiling for placing a public order.',
  PUBLIC_READ_RATE_LIMIT: 'Per-IP ceiling for reading a public menu.',
  JSON_BODY_LIMIT: 'Maximum JSON request body. Defaults to 256kb.',
  TRUST_PROXY: 'Number of proxies in front of this process. Off by default.',
  REDIS_URL: 'Optional cache. Absent means every read goes to Postgres.',
  PORT: 'Listening port. Defaults to 3000.',
  NODE_ENV: 'production enables the stricter checks below.',
};

/** Reads and checks the environment. Pure — it never exits or logs. */
export function inspectConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const fatal: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];
  const production = env.NODE_ENV === 'production';

  // ---- Fatal: cannot serve traffic without these ---------------------------

  if (!env.DATABASE_URL) {
    fatal.push({
      variable: 'DATABASE_URL',
      message: 'not set — there is no database to serve from.',
    });
  } else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
    fatal.push({
      variable: 'DATABASE_URL',
      message: 'is not a postgres:// URL.',
    });
  } else if (/\/\/postgres:/.test(env.DATABASE_URL) && production) {
    // The migrations run as postgres; the API must not. A superuser connection
    // BYPASSES RLS, so every tenant boundary in this system would be off.
    fatal.push({
      variable: 'DATABASE_URL',
      message:
        'connects as the postgres superuser. A superuser bypasses row level ' +
        'security, so every tenant boundary would be disabled. Use mosaiz_app_user.',
    });
  }

  if (!env.SUPABASE_JWT_SECRET && !env.SUPABASE_JWT_PUBLIC_KEY) {
    fatal.push({
      variable: 'SUPABASE_JWT_SECRET / SUPABASE_JWT_PUBLIC_KEY',
      message:
        'neither is set — no token can be verified, so every authenticated ' +
        'request would answer 500 while /health kept reporting ok.',
    });
  }

  if (production && !env.CORS_ORIGINS) {
    // The default is a development origin. Unset in production the admin app
    // is simply blocked by the browser, which surfaces as a CORS error with
    // no server-side symptom at all.
    fatal.push({
      variable: 'CORS_ORIGINS',
      message:
        'not set in production, so only http://localhost:5173 is allowed and ' +
        'the admin app would be blocked by the browser with nothing in the logs.',
    });
  }

  // ---- Warnings: it will run, but this is probably not what was meant ------

  if (production && !env.TRUST_PROXY) {
    warnings.push({
      variable: 'TRUST_PROXY',
      message:
        'not set. Behind a load balancer every request appears to come from ' +
        'the proxy, so the per-IP rate limit is shared by all users at once.',
    });
  }

  if (production && !env.REDIS_URL) {
    warnings.push({
      variable: 'REDIS_URL',
      message: 'not set. Supported — every read goes to Postgres — but slower.',
    });
  }

  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    warnings.push({
      variable: 'SUPABASE_SERVICE_ROLE_KEY',
      message:
        'is present. It bypasses RLS: keep it server-side and never ship it ' +
        'to a browser bundle.',
    });
  }

  for (const numeric of ['PORT', 'RATE_LIMIT_MAX', 'TRUST_PROXY'] as const) {
    const raw = env[numeric];
    if (raw !== undefined && raw !== '' && !Number.isFinite(Number(raw))) {
      fatal.push({ variable: numeric, message: `is not a number: ${raw}` });
    }
  }

  const unknown = Object.keys(env).filter(
    (k) => k.startsWith('SUPABASE_') && !(k in KNOWN_VARIABLES),
  );
  for (const k of unknown) {
    warnings.push({
      variable: k,
      message: 'is set but nothing reads it — check for a typo.',
    });
  }

  return {
    fatal,
    warnings,
    enabled: {
      cache: Boolean(env.REDIS_URL),
      supabaseAdmin: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      userWebhook: Boolean(env.SUPABASE_WEBHOOK_SECRET),
      es256: Boolean(env.SUPABASE_JWT_PUBLIC_KEY),
      hs256: Boolean(env.SUPABASE_JWT_SECRET),
    },
  };
}

/** Human-readable, for the boot log. */
export function formatReport(report: ConfigReport): string {
  const lines: string[] = [];
  for (const p of report.fatal) lines.push(`  FATAL   ${p.variable}: ${p.message}`);
  for (const p of report.warnings) lines.push(`  warning ${p.variable}: ${p.message}`);
  const on = Object.entries(report.enabled)
    .map(([k, v]) => `${k}=${v ? 'on' : 'off'}`)
    .join('  ');
  lines.push(`  capabilities: ${on}`);
  return lines.join('\n');
}
