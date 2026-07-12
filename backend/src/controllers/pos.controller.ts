import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

// Pulls the PostgreSQL SQLSTATE out of a Prisma raw-query error, when present.
// A raw CALL that the database rejects surfaces as a PrismaClientKnownRequestError
// whose meta.code is the 5-char SQLSTATE (e.g. 42501 RLS, 23514 CHECK, P0001
// RAISE). Its absence means the failure was not a database rejection.
function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') {
      return meta.code;
    }
  }
  return undefined;
}

/**
 * POST /api/pos/checkout
 *
 * Routes the cart to the idempotent app.process_pos_checkout stored procedure.
 * Runs on req.tx — the auth middleware's transaction that already bound
 * app.current_user_id — so the SECURITY INVOKER procedure sees the caller's
 * identity and RLS enforces tenancy (a payload for another org is rejected in
 * the database, not by application-side filtering).
 */
export async function processCheckout(req: Request, res: Response): Promise<void> {
  const checkoutPayload = req.body;

  if (
    checkoutPayload === null ||
    typeof checkoutPayload !== 'object' ||
    Array.isArray(checkoutPayload)
  ) {
    res.status(400).json({ error: 'Request body must be a JSON checkout payload' });
    return;
  }

  if (!req.tx) {
    // The auth middleware always sets req.tx; this guards against a route being
    // mounted without it.
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    // The payload is bound as a parameter and cast to jsonb in-database — never
    // string-concatenated — so there is no injection surface. Idempotent: a
    // retried client_offline_id is a silent no-op in the procedure and still
    // returns 200 here.
    await req.tx.$executeRaw`CALL app.process_pos_checkout(${JSON.stringify(
      checkoutPayload,
    )}::jsonb)`;

    res.status(200).json({ status: 'ok', message: 'Checkout processed' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pos.checkout] failed:', err);

    const pgCode = postgresErrorCode(err);
    if (pgCode) {
      // The database rejected the request: RLS (42501), a CHECK/FK/UNIQUE
      // violation, a raised exception (P0001), or invalid JSON/UUID. All are
      // the caller's fault — surface the SQLSTATE without the raw DB message.
      res.status(400).json({ error: 'Checkout could not be processed', code: pgCode });
      return;
    }

    res.status(500).json({ error: 'Internal server error' });
  }
}
