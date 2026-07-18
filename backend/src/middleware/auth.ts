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

// Thrown when the client disconnects before the handler responds, so the
// transaction ROLLS BACK rather than committing partial work (analysis F-05).
class ClientAbortError extends Error {}

/**
 * Authenticates the request against Supabase Auth (the external IdP), then
 * binds the verified identity to the database session so RLS enforces tenancy.
 *
 * The token is a Supabase-issued JWT. Modern Supabase projects sign access
 * tokens with an asymmetric ES256 key (published at the project's JWKS URL);
 * legacy projects — and our Jest suites — use an HS256 shared secret. We
 * dispatch on the token's declared algorithm, but each path is pinned to its
 * own algorithm AND its own key (SUPABASE_JWT_PUBLIC_KEY for ES256,
 * SUPABASE_JWT_SECRET for HS256), so the classic algorithm-confusion downgrade
 * (verifying an HS256 token against the public key as if it were a secret) is
 * impossible, as is `none`. The `sub` claim (the user's UUID) is the identity.
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
  // PEM stored in .env with \n escapes — expand them back into real newlines.
  const publicKey = process.env.SUPABASE_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (!secret && !publicKey) {
    // Fail closed on misconfiguration — never fall through to an open state.
    // eslint-disable-next-line no-console
    console.error(
      'Neither SUPABASE_JWT_PUBLIC_KEY nor SUPABASE_JWT_SECRET is set; refusing to authenticate',
    );
    res.status(500).json({ error: 'Authentication is not configured' });
    return;
  }

  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // eslint-disable-next-line no-console
    console.warn('[auth] rejected: no Authorization: Bearer header on', req.method, req.path);
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

  // Dispatch on the token's DECLARED algorithm, but verify each with its own
  // pinned algorithm + key material. The declared alg only selects between two
  // independently sound verifiers; it can never weaken either one.
  const declaredAlg = jwt.decode(token, { complete: true })?.header.alg;

  let payload: jwt.JwtPayload;
  try {
    let decoded: string | jwt.JwtPayload;
    if (declaredAlg === 'ES256' && publicKey) {
      decoded = jwt.verify(token, publicKey, { algorithms: ['ES256'] });
    } else if (declaredAlg === 'HS256' && secret) {
      decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[auth] rejected: unsupported/unconfigured token alg "${declaredAlg}"`);
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    // A string payload means the JWT had a non-JSON body — reject it.
    if (typeof decoded === 'string') {
      res.status(401).json({ error: 'Invalid token payload' });
      return;
    }
    payload = decoded;
  } catch (err) {
    // Covers expired tokens, bad signatures, wrong algorithm, malformed JWTs.
    // Log the verifier's exact reason (never the token) — this is the line to
    // watch when a client mysteriously 401s.
    // eslint-disable-next-line no-console
    console.warn(
      `[auth] JWT verification failed (alg=${declaredAlg}):`,
      err instanceof Error ? err.message : err,
    );
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
        // In ONE round-trip, bind the RLS identity for the lifetime of THIS
        // transaction AND bound its runtime (analysis F-02): statement_timeout
        // kills a runaway query, idle_in_transaction_session_timeout kills a
        // stuck or abandoned transaction — so a slow handler can never pin its
        // pooled connection open indefinitely and starve the pool. set_config
        // with is_local = true is the bind-parameter-safe SET LOCAL.
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true),
                  set_config('statement_timeout', '15s', true),
                  set_config('idle_in_transaction_session_timeout', '15s', true)`,
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

          // Client hung up before the handler responded: roll back (F-05).
          // Committing here would persist whatever partial work had run.
          res.once('close', () => {
            if (!captured) reject(new ClientAbortError());
          });

          try {
            next();
          } catch (err) {
            reject(err);
          }
        });
      },
      // maxWait bounds how long a request queues for a pooled connection before
      // failing fast; timeout is the ceiling on the whole transaction and sits
      // ABOVE the 15s PG timeouts so those fire first with a precise error.
      { maxWait: 5_000, timeout: 20_000 },
    );

    // Committed. Restore the real end and flush the buffered response.
    res.end = realEnd;
    if (captured && !res.writableEnded) {
      (realEnd as (...args: unknown[]) => unknown)(...endArgs);
    }
  } catch (err) {
    // Restore res.end so the error handler can actually send.
    res.end = realEnd;
    // Client already gone (F-05): the transaction rolled back and there is no
    // socket to answer — nothing more to do.
    if (err instanceof ClientAbortError) return;
    next(err as Error);
  }
}
