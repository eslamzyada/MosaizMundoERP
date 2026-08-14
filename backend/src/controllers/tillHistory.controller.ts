import { Request, Response } from 'express';
import { resolveMembership } from '../middleware/requireRole';

/**
 * Cash-ups, and the pattern in them.
 *
 * 0047 tells an owner the moment a drawer is out. That is the right alert and
 * it is not enough, because the alert is per-night and the question a manager
 * actually has is not "was tonight out?" — it is:
 *
 *     is this happening, and is it happening to the same person?
 *
 * A drawer five short once is a miscount. The same till five short on nine
 * nights out of ten is a different fact entirely, and no sequence of
 * single-night notifications ever adds up to it in somebody's head.
 *
 * ----------------------------------------------------------------------------
 * REPORTING WITHOUT ACCUSING.
 *
 * This endpoint names people next to money that went missing, which is about
 * as consequential as this system gets. Three deliberate choices:
 *
 * 1. `net` is reported ALONGSIDE `short_nights`, never instead. Someone
 *    ten over one night and ten short the next nets to zero, and that is two
 *    mistakes, not none. Netting alone hides exactly the person worth asking.
 *
 * 2. Counts come with a DENOMINATOR. "Short four times" is meaningless until
 *    you know it was four of five or four of ninety, and whoever closes the
 *    most drawers will always top an absolute count — which would point
 *    management at their most reliable person.
 *
 * 3. There is no score, no ranking, and no flag. The arithmetic is presented
 *    and a human decides. A number that sorts people by suspicion gets acted
 *    on as though it were evidence, and it is not.
 */

interface Row {
  id: string;
  opened_at: Date;
  closed_at: Date | null;
  opening_float: string;
  counted_cash: string | null;
  expected_cash: string | null;
  variance: string | null;
  closed_by: string | null;
  closed_by_email: string | null;
}

function windowFrom(req: Request): { from: Date; to: Date } | null {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from
    ? new Date(String(req.query.from))
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  return { from, to };
}

/** GET /api/till/sessions?from=&to= */
export async function listTillSessions(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const range = windowFrom(req);
  if (!range) {
    res.status(400).json({ error: 'from and to must be dates, and to must be after from' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    // RLS-scoped through req.tx. Only CLOSED drawers: an open one has no
    // variance yet, and showing it with nulls in a list of variances invites
    // somebody to read the blank as a zero.
    const rows = await req.tx.$queryRaw<Row[]>`
      SELECT s.id,
             s.opened_at,
             s.closed_at,
             s.opening_float::text,
             s.counted_cash::text,
             s.expected_cash::text,
             s.variance::text,
             s.closed_by,
             u.email AS closed_by_email
        FROM public.till_sessions s
        LEFT JOIN public.users u ON u.id = s.closed_by
       WHERE s.closed_at IS NOT NULL
         AND s.closed_at >= ${range.from}
         AND s.closed_at < ${range.to}
       ORDER BY s.closed_at DESC`;

    const sessions = rows.map((r) => ({
      id: r.id,
      opened_at: r.opened_at.toISOString(),
      closed_at: r.closed_at ? r.closed_at.toISOString() : null,
      opening_float: Number(r.opening_float),
      counted_cash: r.counted_cash === null ? null : Number(r.counted_cash),
      expected_cash: r.expected_cash === null ? null : Number(r.expected_cash),
      variance: r.variance === null ? null : Number(r.variance),
      // Null when the account has since been removed. Not "unknown person" —
      // the session is still real, it just has nobody to point at any more.
      closed_by: r.closed_by,
      closed_by_email: r.closed_by_email,
    }));

    // ---- The pattern. -----------------------------------------------------
    const byPerson = new Map<
      string,
      { closed_by: string | null; email: string | null; sessions: number; net: number; short_nights: number; over_nights: number; worst_short: number }
    >();

    for (const s of sessions) {
      if (s.variance === null) continue;
      const key = s.closed_by ?? 'unattributed';
      const p =
        byPerson.get(key) ??
        {
          closed_by: s.closed_by,
          email: s.closed_by_email,
          sessions: 0,
          net: 0,
          short_nights: 0,
          over_nights: 0,
          worst_short: 0,
        };

      p.sessions += 1;
      p.net += s.variance;
      if (s.variance < 0) {
        p.short_nights += 1;
        p.worst_short = Math.min(p.worst_short, s.variance);
      } else if (s.variance > 0) {
        p.over_nights += 1;
      }
      byPerson.set(key, p);
    }

    const people = [...byPerson.values()]
      .map((p) => ({
        ...p,
        net: Math.round(p.net * 100) / 100,
        // The denominator, carried with the count so the two cannot be
        // separated by whoever renders this.
        short_rate: p.sessions === 0 ? null : Math.round((p.short_nights / p.sessions) * 1000) / 10,
      }))
      // Most drawers closed first — NOT worst variance first. Sorting by
      // variance turns the response into a ranking of suspicion, which is a
      // judgement this endpoint has no business making.
      .sort((a, b) => b.sessions - a.sessions);

    const withVariance = sessions.filter((s) => s.variance !== null);
    const out = withVariance.filter((s) => (s.variance as number) !== 0);

    res.status(200).json({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      sessions,
      people,
      summary: {
        closed: sessions.length,
        balanced: withVariance.length - out.length,
        out: out.length,
        // Net across the period, and the gross short beside it. Net alone
        // reads as "nearly nothing is wrong" on a month where money went out
        // on Tuesday and came back on Wednesday.
        net: Math.round(withVariance.reduce((a, s) => a + (s.variance as number), 0) * 100) / 100,
        total_short:
          Math.round(
            withVariance
              .filter((s) => (s.variance as number) < 0)
              .reduce((a, s) => a + (s.variance as number), 0) * 100,
          ) / 100,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[till.sessions] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
