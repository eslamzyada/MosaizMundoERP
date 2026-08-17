import { logger } from '../lib/logger';
import { NextFunction, Request, Response } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

// The raw request body is captured by the express.json({ verify }) hook in
// app.ts. HMAC must be computed over the exact bytes Supabase signed, not over
// a re-serialized object, so we rely on that buffer here.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

/**
 * Constant-time equality for two secrets of unknown length.
 *
 * timingSafeEqual throws when the buffers differ in length, so comparing raw
 * values would either crash on a short input or need a length check that leaks
 * the secret's length through timing. Hashing both sides first makes every
 * comparison exactly 32 bytes: no throw, no length signal, still constant time.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Authenticates the Supabase identity webhook. This is the ONLY auth on the
 * route — it must NOT sit behind the JWT middleware, since Supabase, not a
 * logged-in user, calls it.
 *
 * TWO ACCEPTED SCHEMES, both keyed by SUPABASE_WEBHOOK_SECRET:
 *
 *   1. `x-supabase-signature` — HMAC-SHA256 over the raw body. The stronger of
 *      the two and the preferred one: the secret itself never crosses the wire,
 *      and a captured signature is only valid for the exact bytes it signed.
 *
 *   2. `x-webhook-token` — the shared secret sent verbatim as a static header.
 *      Weaker, and deliberately supported anyway: Supabase's built-in Database
 *      Webhooks can attach arbitrary static headers but cannot compute an HMAC
 *      over the body, so without this the product's own webhook feature simply
 *      could not authenticate against us. This is "Option A" in
 *      docs/production_runbook.md §3.
 *
 * HONEST TRADE-OFF, since accepting both means the security is that of the
 * WEAKER path, not the stronger one. A static token travels on every request,
 * so anything that can read a request — a compromised TLS terminator, a
 * misconfigured proxy, an over-eager request log — learns a credential that is
 * then replayable against ANY body. The HMAC secret never travels and so cannot
 * leak that way. Do not read "we use HMAC" as protection while a token is
 * configured: an attacker chooses the path, and they will choose this one.
 *
 * Mitigations that make it acceptable here: HTTPS is mandatory in front of the
 * API; the secret is single-purpose (it grants exactly one action, provisioning
 * a tenant from a signup event, and no session or data access); and the handler
 * is idempotent, so a replay is a no-op. Prefer scheme 1 when whatever calls
 * this can compute an HMAC — an Edge Function bridge can, which is the upgrade
 * path off the token entirely.
 *
 * Replay (analysis F-11): neither scheme's payload carries a timestamp or nonce,
 * so a captured valid delivery could in principle be replayed. The residual risk
 * is neutralized by handler idempotency — app.accept_invitation consumes the
 * invite and provisioning is unique-constrained, so a replay returns 200 having
 * changed nothing. A signed-timestamp freshness window is the upgrade path if
 * the payload gains one; a nonce store is deliberately avoided as
 * disproportionate here.
 */
export function webhookAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed on misconfiguration.
    logger.error('webhook refused: SUPABASE_WEBHOOK_SECRET is not set', undefined, {
      request_id: req.requestId,
    });
    res.status(500).json({ error: 'Webhook verification is not configured' });
    return;
  }

  const signature = req.header('x-supabase-signature');
  const token = req.header('x-webhook-token');

  // Signature first: when a caller can prove it signed the body, that proof is
  // what we check. Falling back to the token after a FAILED signature would let
  // an attacker downgrade to the weaker scheme by sending both, so a present
  // signature is decided on its own merits and never re-tried as a token.
  if (signature) {
    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      res.status(401).json({ error: 'Missing request body' });
      return;
    }

    const expectedHex = createHmac('sha256', secret).update(raw).digest('hex');
    const expected = Buffer.from(expectedHex, 'hex');
    // Tolerate an optional "sha256=" prefix; invalid hex yields a short buffer,
    // which the length check below rejects without timingSafeEqual throwing.
    const provided = Buffer.from(signature.replace(/^sha256=/i, ''), 'hex');

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    next();
    return;
  }

  if (token) {
    if (!secretsMatch(token, secret)) {
      res.status(401).json({ error: 'Invalid webhook token' });
      return;
    }

    next();
    return;
  }

  res.status(401).json({
    error: 'Missing x-supabase-signature or x-webhook-token header',
  });
}
