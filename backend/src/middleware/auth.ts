import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';
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
 * Authenticates the request against Supabase Auth (the external IdP), then
 * binds the verified identity to the database session so RLS enforces tenancy.
 *
 * The token is a Supabase-issued JWT (HS256, signed with the project's JWT
 * secret). We verify the signature and expiry, pin the algorithm to HS256 so a
 * forged token cannot downgrade to `none` or a different scheme, and take the
 * `sub` claim (the user's UUID) as the identity.
 *
 * The verified UUID is then bound for the lifetime of ONE Prisma interactive
 * transaction via `set_config('app.current_user_id', $1, true)` (the
 * bind-parameter-safe, transaction-local equivalent of SET LOCAL). The whole
 * downstream handler runs inside that transaction, so its req.tx queries are
 * subject to the RLS policies keyed off that user.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    // Fail closed on misconfiguration — never fall through to an open state.
    // eslint-disable-next-line no-console
    console.error('SUPABASE_JWT_SECRET is not set; refusing to authenticate');
    res.status(500).json({ error: 'Authentication is not configured' });
    return;
  }

  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res
      .status(401)
      .json({ error: 'Missing or malformed Authorization: Bearer <token> header' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    // A string payload means the JWT had a non-JSON body — reject it.
    if (typeof decoded === 'string') {
      res.status(401).json({ error: 'Invalid token payload' });
      return;
    }
    payload = decoded;
  } catch {
    // Covers expired tokens, bad signatures, wrong algorithm, malformed JWTs.
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const userId = payload.sub;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    res.status(401).json({ error: 'Token is missing a valid subject (sub) claim' });
    return;
  }

  // The handler's response is buffered and only flushed to the client AFTER the
  // transaction commits, so a client that reads its own write on a subsequent
  // request always sees committed data (no read-after-write race). All of
  // res.json/res.send funnel through res.end, so intercepting res.end alone
  // captures the terminal write regardless of how the handler responds.
  const realEnd = res.end.bind(res);
  let endArgs: unknown[] = [];
  let captured = false;

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

        // Resolve (→ commit) as soon as the handler finishes writing, but hold
        // the actual flush until after the transaction has committed.
        await new Promise<void>((resolve, reject) => {
          res.end = ((...args: unknown[]) => {
            if (!captured) {
              captured = true;
              endArgs = args;
            }
            resolve();
            return res;
          }) as typeof res.end;

          // Client hung up before the handler responded: stop waiting.
          res.once('close', () => resolve());

          try {
            next();
          } catch (err) {
            reject(err);
          }
        });
      },
      { timeout: 15_000 },
    );

    // Committed. Restore the real end and flush the buffered response.
    res.end = realEnd;
    if (captured && !res.writableEnded) {
      (realEnd as (...args: unknown[]) => unknown)(...endArgs);
    }
  } catch (err) {
    // Rolled back. Restore res.end so the error handler can actually send.
    res.end = realEnd;
    next(err as Error);
  }
}
