import { Request, Response } from 'express';
import { enabledModules } from '../lib/modules';
import { resolveMembership } from '../middleware/requireRole';

/**
 * What a service cost, and what it earned.
 *
 * Everything 0038–0043 produced — hours, pay, bookings, seatings, online
 * orders — is written and nothing reads it. This is the report that does, and
 * it exists to answer the one question a restaurant is actually run by: what
 * share of tonight's takings went on wages.
 *
 * ----------------------------------------------------------------------------
 * TWO RULES, AND THEY ARE THE SAME RULE TWICE.
 *
 * 1. A SECTION A TENANT DOES NOT RUN IS ABSENT, NOT ZERO. A restaurant with
 *    reservations switched off has no covers — it does not have "0 covers",
 *    which would read as a catastrophic night.
 *
 * 2. SOMETHING THIS CALLER MAY NOT SEE IS NULL, NOT ZERO. 0042 makes pay
 *    confidential, and app.wage_at runs as the caller — so a branch manager
 *    asking for this gets covers and revenue and `labour: null`. Their labour
 *    percentage is unknown, and unknown is the honest word for it.
 *
 * Both are the distinction cost_is_complete already draws for COGS: a gap you
 * can see is survivable, a gap that reads as a number is not.
 */

function windowFrom(req: Request): { from: Date; to: Date } | null {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from
    ? new Date(String(req.query.from))
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  return { from, to };
}

/** GET /api/reports/service?from=&to= */
export async function getServiceReport(req: Request, res: Response): Promise<void> {
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
    const modules = await enabledModules(req.tx, membership.organization_id);

    // ---- Revenue. Always present: every restaurant sells something. --------
    const [takings] = await req.tx.$queryRaw<Array<{ revenue: string; orders: number }>>`
      SELECT COALESCE(SUM(o.total_amount), 0)::text AS revenue,
             COUNT(*)::int AS orders
        FROM public.orders o
       WHERE o.created_at >= ${range.from}
         AND o.created_at < ${range.to}
         AND o.status <> 'voided'`;

    const revenue = Number(takings.revenue);

    // ---- Labour. Present only if the tenant runs it, and only costed as far
    //      as this caller is entitled to see. ---------------------------------
    let labour: {
      minutes: number;
      hours: number;
      cost: number | null;
      uncosted_entries: number;
      share_of_revenue: number | null;
    } | null = null;

    if (modules.includes('labour')) {
      const [row] = await req.tx.$queryRaw<
        Array<{ minutes: number; cost: string | null; uncosted: number }>
      >`
        WITH costed AS (
          SELECT EXTRACT(EPOCH FROM (COALESCE(t.ended_at, now()) - t.started_at)) / 60 AS minutes,
                 app.wage_at(t.user_id, t.started_at::date) AS rate
            FROM public.time_entries t
           WHERE t.started_at >= ${range.from}
             AND t.started_at < ${range.to}
        )
        SELECT COALESCE(SUM(minutes), 0)::int AS minutes,
               CASE WHEN COUNT(rate) = 0 THEN NULL
                    ELSE ROUND(SUM(minutes / 60 * rate) FILTER (WHERE rate IS NOT NULL), 2)::text
               END AS cost,
               COUNT(*) FILTER (WHERE rate IS NULL)::int AS uncosted
          FROM costed`;

      const cost = row.cost === null ? null : Number(row.cost);

      labour = {
        minutes: Number(row.minutes),
        hours: Math.round((Number(row.minutes) / 60) * 100) / 100,
        cost,
        uncosted_entries: Number(row.uncosted),
        // THE NUMBER. Null when the cost is unknown or there were no takings —
        // dividing by zero revenue would report an infinite wage bill on a
        // closed day, which is arithmetic rather than information.
        share_of_revenue:
          cost === null || revenue <= 0
            ? null
            : Math.round((cost / revenue) * 1000) / 10,
      };
    }

    // ---- Covers. The promise 0043 made in its own comment. -----------------
    let covers: {
      booked: number;
      seated: number;
      no_show: number;
      cancelled: number;
      turned_into_money: number;
      no_show_rate: number | null;
    } | null = null;

    if (modules.includes('reservations')) {
      const [row] = await req.tx.$queryRaw<
        Array<{
          booked: number;
          seated: number;
          no_show: number;
          cancelled: number;
          guests: number;
          seated_with_order: number;
        }>
      >`
        SELECT COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE r.status IN ('seated', 'completed'))::int AS seated,
               COUNT(*) FILTER (WHERE r.status = 'no_show')::int AS no_show,
               COUNT(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
               COALESCE(SUM(r.party_size), 0)::int AS guests,
               -- The link 0043 added: a booking that became a tab.
               COUNT(*) FILTER (WHERE r.seated_order_id IS NOT NULL)::int AS seated_with_order
          FROM public.reservations r
         WHERE r.starts_at >= ${range.from}
           AND r.starts_at < ${range.to}`;

      const decided = Number(row.seated) + Number(row.no_show);

      covers = {
        booked: Number(row.booked),
        seated: Number(row.seated),
        no_show: Number(row.no_show),
        cancelled: Number(row.cancelled),
        turned_into_money: Number(row.seated_with_order),
        // Out of bookings that were DECIDED. Counting cancellations as
        // no-shows would blame the restaurant for guests who rang ahead —
        // those are two different failures with two different fixes.
        no_show_rate: decided === 0 ? null : Math.round((Number(row.no_show) / decided) * 1000) / 10,
      };
    }

    // ---- Online orders. --------------------------------------------------
    let online: {
      received: number;
      accepted: number;
      rejected: number;
      pending: number;
      acceptance_rate: number | null;
    } | null = null;

    if (modules.includes('public_ordering')) {
      const [row] = await req.tx.$queryRaw<
        Array<{ received: number; accepted: number; rejected: number; pending: number }>
      >`
        SELECT COUNT(*)::int AS received,
               COUNT(*) FILTER (WHERE p.status IN ('accepted', 'fulfilled'))::int AS accepted,
               COUNT(*) FILTER (WHERE p.status = 'rejected')::int AS rejected,
               COUNT(*) FILTER (WHERE p.status = 'pending')::int AS pending
          FROM public.public_orders p
         WHERE p.created_at >= ${range.from}
           AND p.created_at < ${range.to}`;

      const decided = Number(row.accepted) + Number(row.rejected);

      online = {
        received: Number(row.received),
        accepted: Number(row.accepted),
        rejected: Number(row.rejected),
        // Worth surfacing on its own: a request still pending at the end of a
        // service is a customer nobody answered.
        pending: Number(row.pending),
        acceptance_rate:
          decided === 0 ? null : Math.round((Number(row.accepted) / decided) * 1000) / 10,
      };
    }

    // ---- How the money came in (0046). ------------------------------------
    //
    // `unspecified` is a first-class row here, not a rounding error. Every sale
    // settled before 0046, and every sale from a till that has not been
    // updated, has no tender recorded — and folding those into cash would make
    // the nightly cash-up a fiction somebody acts on.
    const mixRows = await req.tx.$queryRaw<Array<{ method: string; amount: string }>>`
      SELECT p.method, SUM(p.amount)::text AS amount
        FROM public.order_payments p
        JOIN public.orders o ON o.id = p.order_id
       WHERE o.created_at >= ${range.from}
         AND o.created_at < ${range.to}
         AND o.status <> 'voided'
       GROUP BY p.method`;

    const attributed = mixRows.reduce((sum, r) => sum + Number(r.amount), 0);
    const payment_mix = {
      ...Object.fromEntries(mixRows.map((r) => [r.method, Number(r.amount)])),
      // What the restaurant took and cannot account for by method. Derived
      // rather than counted, so it can never quietly disagree with revenue.
      unspecified: Math.round((revenue - attributed) * 100) / 100,
    };

    res.status(200).json({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      revenue,
      orders: Number(takings.orders),
      payment_mix,
      // Null means "this restaurant does not run that", NOT "none happened".
      labour,
      covers,
      online,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.service] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
