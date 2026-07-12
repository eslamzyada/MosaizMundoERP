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
