import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { resolveMembership } from '../middleware/requireRole';
import { postgresErrorCode } from '../lib/postgresError';

/**
 * The drawer (0047).
 *
 * Three things a till needs to know and do: is it open, open it, close it and
 * find out whether it balances.
 *
 * The arithmetic is entirely in the database — `expected` is float plus CASH
 * against this session, and the variance is frozen at close. Nothing here
 * recomputes any of it, because a second implementation of the one number a
 * cashier is held to could only ever disagree with the first.
 */

/** GET /api/till — the open session, with what should be in the drawer so far. */
export async function getTill(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const [open] = await req.tx.$queryRaw<
      Array<{
        id: string;
        opened_at: Date;
        opening_float: string;
        cash_so_far: string;
        other_so_far: string;
      }>
    >`
      SELECT s.id,
             s.opened_at,
             s.opening_float::text,
             -- What SHOULD be in the drawer, so far. Cash only: a card
             -- payment never entered it, and showing a running total that
             -- included card would have somebody counting to the wrong number.
             COALESCE(SUM(p.amount) FILTER (
                 WHERE p.method = 'cash' AND o.status <> 'voided'), 0)::text AS cash_so_far,
             -- Everything else, reported separately rather than hidden: it is
             -- real revenue, it is just not in the drawer.
             COALESCE(SUM(p.amount) FILTER (
                 WHERE p.method <> 'cash' AND o.status <> 'voided'), 0)::text AS other_so_far
        FROM public.till_sessions s
        LEFT JOIN public.order_payments p ON p.till_session_id = s.id
        LEFT JOIN public.orders o ON o.id = p.order_id
       WHERE s.closed_at IS NULL
       GROUP BY s.id, s.opened_at, s.opening_float`;

    if (!open) {
      // Null, not an empty object. "No drawer is open" is a fact the screen
      // renders; it is not a failure and not an empty session.
      res.status(200).json({ session: null });
      return;
    }

    const float = Number(open.opening_float);
    const cash = Number(open.cash_so_far);

    res.status(200).json({
      session: {
        id: open.id,
        opened_at: open.opened_at.toISOString(),
        opening_float: float,
        cash_taken: cash,
        other_taken: Number(open.other_so_far),
        // What the count should come to if nothing is missing. Named
        // `expected_so_far` rather than `expected` because it is still moving:
        // the frozen one only exists after the close.
        expected_so_far: Math.round((float + cash) * 100) / 100,
      },
    });
  } catch (err) {
    logger.error('till.get failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Maps the two procedures' refusals onto answers a cashier can act on. */
function respond(err: unknown, res: Response, where: string): void {
  const code = postgresErrorCode(err);
  const message = err instanceof Error ? err.message : '';

  // "The till is already open" / "the till is not open" — the request is
  // understood and the state is wrong, which is a 409 and not a 400.
  if (code === '55000') {
    res.status(409).json({ error: message.replace(/^.*?ERROR:\s*/, '') || 'The till is not in that state' });
    return;
  }
  if (code === '22023') {
    res.status(400).json({ error: message.replace(/^.*?ERROR:\s*/, '') || 'Invalid amount' });
    return;
  }
  if (code === '42501') {
    res.status(403).json({ error: 'Opening and closing the till is limited to sales roles' });
    return;
  }
  if (code === 'P0002') {
    res.status(404).json({ error: 'Organization not found' });
    return;
  }

  logger.error(`${where} failed`, err, {
    request_id: res.req?.requestId,
    user_id: res.req?.userId,
  });
  res.status(500).json({ error: 'Internal server error' });
}

/** POST /api/till/open  { opening_float?, note? } */
export async function openTill(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as { opening_float?: unknown; note?: unknown };
  const float = body.opening_float === undefined ? 0 : Number(body.opening_float);
  if (!Number.isFinite(float)) {
    res.status(400).json({ error: 'opening_float must be a number' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const rows = await req.tx.$queryRaw<Array<{ id: string }>>`
      SELECT app.open_till_session(
        ${membership.organization_id}::uuid,
        ${float}::numeric,
        ${typeof body.note === 'string' ? body.note : null}::text) AS id`;

    res.status(200).json({ session_id: rows[0]?.id ?? null });
  } catch (err) {
    respond(err, res, 'till.open');
  }
}

/**
 * POST /api/till/close  { counted_cash, note? }
 *
 * `counted_cash` is REQUIRED and has no default. A close that silently assumed
 * the drawer held exactly what it should would report a variance of zero every
 * night, which is the one answer this endpoint must never invent.
 */
export async function closeTill(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as { counted_cash?: unknown; note?: unknown };
  if (body.counted_cash === undefined || body.counted_cash === null) {
    res.status(400).json({ error: 'counted_cash is required — the drawer has to be counted' });
    return;
  }
  const counted = Number(body.counted_cash);
  if (!Number.isFinite(counted)) {
    res.status(400).json({ error: 'counted_cash must be a number' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    await req.tx.$queryRaw`
      SELECT app.close_till_session(
        ${membership.organization_id}::uuid,
        ${counted}::numeric,
        ${typeof body.note === 'string' ? body.note : null}::text) AS id`;

    // Read back rather than computed here: the row is the record, and the
    // number the cashier sees has to be the number that was stored.
    const [row] = await req.tx.$queryRaw<
      Array<{
        id: string;
        counted_cash: string;
        expected_cash: string;
        variance: string;
        closed_at: Date;
      }>
    >`
      SELECT id, counted_cash::text, expected_cash::text, variance::text, closed_at
        FROM public.till_sessions
       WHERE organization_id = ${membership.organization_id}::uuid
       ORDER BY closed_at DESC NULLS LAST
       LIMIT 1`;

    res.status(200).json({
      session_id: row.id,
      closed_at: row.closed_at.toISOString(),
      counted_cash: Number(row.counted_cash),
      expected_cash: Number(row.expected_cash),
      variance: Number(row.variance),
    });
  } catch (err) {
    respond(err, res, 'till.close');
  }
}
