import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

// The middleware hands the route handler a transaction-scoped Prisma client on
// req.tx. Handlers MUST use req.tx (not the global client) so their queries run
// inside the same transaction that set app.current_user_id — otherwise RLS sees
// no user and returns zero rows.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tx?: Prisma.TransactionClient;
      userId?: string;
    }
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Foundational auth: trusts a `User-Id` header (real JWT verification comes
 * later) and binds it to the database session so RLS can enforce tenancy.
 *
 * The crucial link to the DB's RLS contract: the whole downstream handler runs
 * inside ONE Prisma interactive transaction that first sets the authenticated
 * user for that transaction. We use `set_config('app.current_user_id', $1,
 * true)` rather than `SET LOCAL app.current_user_id = $1`: the SET command
 * cannot take bind parameters (verified — it is a syntax error), whereas
 * set_config takes the value as a real parameter (injection-safe, and the value
 * comes from an untrusted header) and its third argument `true` makes it
 * transaction-local, exactly like SET LOCAL.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.header('User-Id');

  if (!userId || !UUID_RE.test(userId)) {
    res.status(401).json({ error: 'A valid User-Id header (UUID) is required' });
    return;
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        // Bind the RLS identity for the lifetime of THIS transaction only.
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.current_user_id', $1, true)",
          userId,
        );

        req.tx = tx;
        req.userId = userId;

        // Keep the transaction open until the response is fully sent, so the
        // handler's queries on req.tx run under the bound identity. The tx
        // commits when this promise resolves.
        await new Promise<void>((resolve) => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        });
      },
      { timeout: 15_000 },
    );
  } catch (err) {
    next(err as Error);
  }
}
