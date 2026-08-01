import { PrismaClient } from '@prisma/client';

/**
 * The pool is this API's real concurrency ceiling.
 *
 * Every request runs inside ONE interactive transaction — that is how the RLS
 * identity is bound — so a request holds a connection for its whole life. The
 * pool size is therefore the number of requests that can be in flight at once:
 * not a tuning knob, a capacity limit.
 *
 * Prisma's default is num_cpus * 2 + 1, a number nobody chose that changes when
 * the machine changes. And the default pool_timeout is 10 seconds, so the first
 * symptom of saturation is a request waiting ten seconds and THEN failing,
 * rather than a queue that drains.
 *
 * Appended only when the URL does not already say, so an operator who has tuned
 * it keeps their own numbers.
 */
const DEFAULT_CONNECTION_LIMIT = 20;
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

export function withPoolDefaults(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(DEFAULT_CONNECTION_LIMIT));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', String(DEFAULT_POOL_TIMEOUT_SECONDS));
    }
    return url.toString();
  } catch {
    // An unparseable URL is Prisma's to report, with a much better message than
    // anything invented here. Passing it through unchanged is the honest thing.
    return rawUrl;
  }
}

// A single shared client. It connects as mosaiz_app_user (see DATABASE_URL) —
// the RLS-constrained application role — so every query is subject to Row
// Level Security. The per-request transaction in the auth middleware is what
// supplies the `app.current_user_id` the RLS policies read.
const datasourceUrl = withPoolDefaults(process.env.DATABASE_URL);

export const prisma = new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);
