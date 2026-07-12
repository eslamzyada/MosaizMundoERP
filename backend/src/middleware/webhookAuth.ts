import { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

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
 * Verifies the Supabase webhook signature: HMAC-SHA256 of the raw request body
 * keyed by SUPABASE_WEBHOOK_SECRET, compared (in constant time) against the
 * x-supabase-signature header. This is the ONLY auth on the webhook route — it
 * must NOT sit behind the JWT middleware, since Supabase, not a logged-in user,
 * calls it.
 */
export function webhookAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed on misconfiguration.
    // eslint-disable-next-line no-console
    console.error('SUPABASE_WEBHOOK_SECRET is not set; refusing webhook');
    res.status(500).json({ error: 'Webhook verification is not configured' });
    return;
  }

  const signature = req.header('x-supabase-signature');
  if (!signature) {
    res.status(401).json({ error: 'Missing x-supabase-signature header' });
    return;
  }

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
}
