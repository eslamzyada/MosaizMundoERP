import { logger } from '../lib/logger';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates every line this request produces, and is returned to the caller. */
      requestId?: string;
      /**
       * The path as the CLIENT asked for it.
       *
       * Not the same as `req.path` once routing starts: Express rewrites
       * `req.url` when it hands a request to a mounted router, so inside
       * `/api/me` the handler sees `/`. Since the completion line is written
       * from `res.on('finish')` — by which time the rewrite has happened —
       * reading `req.path` there logged `"/"` for every single /api route.
       * Captured once, before any of that.
       */
      requestPath?: string;
    }
  }
}

/**
 * A client-supplied id is UNTRUSTED INPUT, and it ends up in a log file.
 *
 * Left unchecked it is a log injection: a newline in the header writes a second
 * line into the aggregator, which can be shaped to look like a genuine event —
 * a forged "auth succeeded" among real ones. Length matters too; a megabyte of
 * header would be written once per request.
 *
 * So the header is honoured only when it already looks like an id. Anything
 * else is silently replaced with one we generated, which costs the caller
 * nothing: the id we return in the response header is the one that was used.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** An orchestrator probes these every few seconds. Logging them buries everything else. */
const UNLOGGED_PATHS = new Set(['/health', '/ready']);

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  // Captured HERE, at app level, before any router rewrites req.url.
  req.requestPath = req.path;

  const supplied = req.get('x-request-id');
  req.requestId = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();

  // Echoed so the caller — and the support conversation — can quote it.
  res.setHeader('x-request-id', req.requestId);

  if (UNLOGGED_PATHS.has(req.requestPath)) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  // 'finish' fires once the response is flushed, which is the only point where
  // the status and the duration are both known. It also fires on an aborted
  // response, so a request that died halfway is still accounted for rather
  // than vanishing.
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    logger.info('request', {
      request_id: req.requestId,
      method: req.method,
      // The path as asked for, captured above. Never `req.originalUrl`: a
      // query string is exactly where a stray identifier ends up, and this
      // line is kept for a long time.
      path: req.requestPath,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10,
      // Present once the auth middleware has run. Absent on anonymous routes,
      // which is the honest answer rather than a null.
      user_id: req.userId,
      // Only on a failure. An address is personal data, and there is no
      // operational reason to keep one for every successful menu load — but
      // there is every reason to have it for the request that failed.
      ip: res.statusCode >= 400 ? req.ip : undefined,
    });
  });

  next();
}
