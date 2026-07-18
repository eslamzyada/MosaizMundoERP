import { Request } from 'express';

export interface Page {
  take: number;
  skip: number;
}

/**
 * Parses ?limit & ?offset into a bounded Prisma { take, skip } (analysis F-04).
 *
 * Every list endpoint routes through this so a single request can never ask the
 * database for an unbounded result set — which, under the one-transaction-per-
 * request model, would also pin its pooled connection for the whole scan.
 * `limit` is clamped to `maxLimit`; anything missing or invalid falls back to
 * `defaultLimit`.
 */
export function parsePage(
  req: Request,
  opts: { defaultLimit: number; maxLimit: number },
): Page {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);

  let take = opts.defaultLimit;
  if (Number.isFinite(rawLimit) && rawLimit > 0) {
    take = Math.min(Math.floor(rawLimit), opts.maxLimit);
  }

  let skip = 0;
  if (Number.isFinite(rawOffset) && rawOffset > 0) {
    skip = Math.floor(rawOffset);
  }

  return { take, skip };
}

/** A hard safety cap for lists that are naturally bounded (catalog, team) but
 *  still must never scan without limit. */
export const SAFETY_CAP = 500;
