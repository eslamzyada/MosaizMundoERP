import { Request, Response } from 'express';
import { resolveMembership } from '../middleware/requireRole';
import { postgresErrorCode } from '../lib/postgresError';

/**
 * The rota, and the clock (0038).
 *
 * Nothing here writes an hour. `time_entries` is read-only to the application
 * role, so clocking in and out are calls to SECURITY DEFINER procedures that
 * stamp the server clock; this controller's whole job on that side is to turn
 * their refusals into answers somebody can act on.
 *
 * The rota is an ordinary table, gated by 0010's role policies and 0037's
 * module policies. It is written here directly, and the database is what
 * refuses a waiter who tries.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Both ends of the window, defaulting to the coming week. */
function windowFrom(req: Request): { from: Date; to: Date } | null {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date();
  const to = req.query.to
    ? new Date(String(req.query.to))
    : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  return { from, to };
}

/** GET /api/labour/shifts?from=&to= — the rota. Readable by everyone. */
export async function listShifts(req: Request, res: Response): Promise<void> {
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
    const rows = await req.tx.shifts.findMany({
      where: { starts_at: { gte: range.from, lt: range.to } },
      orderBy: { starts_at: 'asc' },
    });
    res.status(200).json(rows);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[labour.shifts] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/labour/shifts — schedule somebody. Managers only (0010). */
export async function createShift(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const { user_id, starts_at, ends_at, note } = req.body ?? {};
  if (!UUID_RE.test(String(user_id ?? ''))) {
    res.status(400).json({ error: 'user_id must be a uuid' });
    return;
  }
  const start = new Date(String(starts_at));
  const end = new Date(String(ends_at));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    res.status(400).json({ error: 'starts_at and ends_at must be timestamps' });
    return;
  }
  if (end <= start) {
    res.status(400).json({ error: 'a shift cannot end before it starts' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const shift = await req.tx.shifts.create({
      data: {
        organization_id: membership.organization_id,
        user_id,
        starts_at: start,
        ends_at: end,
        note: note ? String(note).slice(0, 500) : null,
        created_by: req.userId,
      },
    });
    res.status(201).json(shift);
  } catch (err) {
    const code = postgresErrorCode(err);

    // The EXCLUDE constraint. Its own answer, because "that person is already
    // working then" is a rota problem with a rota fix, not a server fault.
    if (code === '23P01') {
      res.status(409).json({
        error: 'That person is already scheduled during those hours',
        code: 'shift_overlap',
      });
      return;
    }
    if (code === '23514') {
      res.status(400).json({ error: 'A shift must end after it starts, and last at most 24 hours' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Only a manager may write the rota' });
      return;
    }

    // eslint-disable-next-line no-console
    console.error('[labour.createShift] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** DELETE /api/labour/shifts/:id — unschedule. Managers only (0010). */
export async function deleteShift(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  try {
    // deleteMany, so a shift the policy hides matches nothing and answers 404
    // rather than confirming that it exists.
    const result = await req.tx.shifts.deleteMany({ where: { id: req.params.id } });
    if (result.count === 0) {
      res.status(404).json({ error: 'No such shift' });
      return;
    }
    res.status(200).json({ id: req.params.id, deleted: true });
  } catch (err) {
    if (postgresErrorCode(err) === '42501') {
      res.status(403).json({ error: 'Only a manager may write the rota' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[labour.deleteShift] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/labour/clock — am I clocked in, and since when? */
export async function currentEntry(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  try {
    // No `where: { user_id }` beyond the open filter — the own-row policy is
    // what scopes this, and a filter here would be a second rule to disagree
    // with it.
    const open = await req.tx.time_entries.findFirst({
      where: { user_id: req.userId, ended_at: null },
    });
    res.status(200).json({ clocked_in: !!open, since: open?.started_at ?? null, id: open?.id ?? null });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[labour.currentEntry] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/labour/clock-in */
export async function clockIn(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  const shiftId = req.body?.shift_id ?? null;
  if (shiftId !== null && !UUID_RE.test(String(shiftId))) {
    res.status(400).json({ error: 'shift_id must be a uuid' });
    return;
  }

  try {
    const [row] = await req.tx.$queryRaw<Array<{ clock_in: string }>>`
      SELECT app.clock_in(${shiftId}::uuid) AS clock_in`;
    res.status(201).json({ id: row.clock_in });
  } catch (err) {
    res.status(mapClockError(err)).json(clockBody(err, 'clocking in'));
  }
}

/** POST /api/labour/clock-out */
export async function clockOut(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const [row] = await req.tx.$queryRaw<Array<{ clock_out: number }>>`
      SELECT app.clock_out() AS clock_out`;
    res.status(200).json({ minutes: Number(row.clock_out) });
  } catch (err) {
    res.status(mapClockError(err)).json(clockBody(err, 'clocking out'));
  }
}

/**
 * The clock's refusals are all states, not faults, and they map to different
 * answers: 409 for "you are already clocked in", 403 for no identity, and 409
 * with a distinct code for a module the restaurant does not run — which is a
 * setting somebody can change, not an error to report.
 */
function mapClockError(err: unknown): number {
  const code = postgresErrorCode(err);
  if (code === '55000') return 409;
  if (code === '0A000') return 409;
  if (code === '42501') return 403;
  return 500;
}

function clockBody(err: unknown, action: string): Record<string, unknown> {
  const code = postgresErrorCode(err);
  if (code === '0A000') {
    return {
      error: 'This restaurant does not run the labour module',
      code: 'module_disabled',
      module: 'labour',
      enable_at: '/settings',
    };
  }
  if (code === '55000') {
    return { error: 'The clock is not in the state that needs', code: 'clock_state' };
  }
  if (code === '42501') {
    return { error: `You are not allowed to do that (${action})` };
  }
  // eslint-disable-next-line no-console
  console.error(`[labour.${action}] failed:`, err);
  return { error: 'Internal server error' };
}

/**
 * GET /api/labour/hours?from=&to= — minutes worked per person.
 *
 * The reason the clock exists. Scoped by the own-row policy, so a waiter
 * calling this gets their own hours and a manager gets everybody's — one
 * endpoint, two honest answers, no role branch in the code.
 */
export async function hours(req: Request, res: Response): Promise<void> {
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
    /**
     * Cost is computed PER ENTRY, at the rate that applied on the day it was
     * worked — not by multiplying a period's total hours by today's rate. Give
     * somebody a raise mid-month and the two answers differ, and only one of
     * them is what you owe.
     *
     * app.wage_at runs as the caller (0042), so a branch manager gets NULL for
     * colleagues whose pay they may not read. That is why `cost` is nullable
     * and why `uncosted_entries` exists: unknown and zero are different
     * answers, exactly as cost_is_complete distinguishes them for COGS.
     */
    const rows = await req.tx.$queryRaw<
      Array<{
        user_id: string;
        minutes: number;
        entries: number;
        cost: string | null;
        uncosted_entries: number;
      }>
    >`
      WITH costed AS (
        SELECT t.user_id,
               -- An entry still open counts up to now, so today's total is not
               -- a lie by omission while somebody is still on the floor.
               EXTRACT(EPOCH FROM (COALESCE(t.ended_at, now()) - t.started_at)) / 60
                 AS minutes,
               app.wage_at(t.user_id, t.started_at::date) AS rate
          FROM public.time_entries t
         WHERE t.started_at >= ${range.from}
           AND t.started_at < ${range.to}
      )
      SELECT user_id,
             COALESCE(SUM(minutes), 0)::int AS minutes,
             COUNT(*)::int AS entries,
             -- NULL when nothing could be costed, rather than 0.00.
             CASE WHEN COUNT(rate) = 0 THEN NULL
                  ELSE ROUND(SUM(minutes / 60 * rate) FILTER (WHERE rate IS NOT NULL), 2)
             END AS cost,
             COUNT(*) FILTER (WHERE rate IS NULL)::int AS uncosted_entries
        FROM costed
       GROUP BY user_id
       ORDER BY minutes DESC`;

    const byEmployee = rows.map((r) => ({
      user_id: r.user_id,
      minutes: Number(r.minutes),
      hours: Math.round((Number(r.minutes) / 60) * 100) / 100,
      entries: Number(r.entries),
      // null, not 0: nobody's pay is unknown AND free.
      cost: r.cost === null ? null : Number(r.cost),
      uncosted_entries: Number(r.uncosted_entries),
    }));

    const costed = byEmployee.filter((r) => r.cost !== null);

    res.status(200).json({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      by_employee: byEmployee,
      // The total is only the part that could be costed, and the count beside
      // it says how much was left out. A single number with silent gaps in it
      // is worse than no number, because somebody will budget against it.
      total_cost: costed.length
        ? Math.round(costed.reduce((sum, r) => sum + (r.cost ?? 0), 0) * 100) / 100
        : null,
      uncosted_entries: byEmployee.reduce((sum, r) => sum + r.uncosted_entries, 0),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[labour.hours] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/labour/entries/:id/amend — a manager fixing a forgotten clock-out. */
export async function amendEntry(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  const { started_at, ended_at, reason } = req.body ?? {};
  const start = new Date(String(started_at));
  const end = ended_at ? new Date(String(ended_at)) : null;
  if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) {
    res.status(400).json({ error: 'started_at and ended_at must be timestamps' });
    return;
  }
  if (!reason || String(reason).trim().length < 3) {
    res.status(400).json({ error: 'An amendment needs a reason' });
    return;
  }

  try {
    await req.tx.$queryRaw`
      SELECT app.amend_time_entry(
        ${req.params.id}::uuid, ${start}::timestamptz, ${end}::timestamptz, ${String(reason)})`;
    res.status(200).json({ id: req.params.id, amended: true });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '42501') {
      res.status(403).json({ error: 'Only a manager may amend a time entry' });
      return;
    }
    if (code === '22023') {
      res.status(400).json({ error: 'That amendment does not make sense' });
      return;
    }
    if (code === 'P0002' || code === '02000') {
      res.status(404).json({ error: 'No such time entry' });
      return;
    }
    if (code === '0A000') {
      res.status(409).json({
        error: 'This restaurant does not run the labour module',
        code: 'module_disabled',
        module: 'labour',
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[labour.amendEntry] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/labour/wages?user_id= — pay history.
 *
 * No role branch here on purpose. 0042's policy decides what comes back: your
 * own always, everybody's for the owner, the regional manager and the
 * accountant. A filter in this handler would be a second rule that can
 * disagree with the first — and on this table, disagreeing means leaking pay.
 */
export async function listWages(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const userId = req.query.user_id ? String(req.query.user_id) : null;
  if (userId !== null && !UUID_RE.test(userId)) {
    res.status(400).json({ error: 'user_id must be a uuid' });
    return;
  }

  try {
    const rows = await req.tx.employee_wages.findMany({
      where: userId ? { user_id: userId } : {},
      orderBy: [{ user_id: 'asc' }, { effective_from: 'desc' }],
    });
    res.status(200).json(rows);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[labour.listWages] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/labour/wages — record a rate from a date.
 *
 * A raise is a new row, never an edit, so there is deliberately no PATCH: an
 * edit would rewrite what somebody was owed last month.
 */
export async function setWage(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const { user_id, hourly_rate, effective_from, note } = req.body ?? {};
  if (!UUID_RE.test(String(user_id ?? ''))) {
    res.status(400).json({ error: 'user_id must be a uuid' });
    return;
  }

  const rate = Number(hourly_rate);
  if (!Number.isFinite(rate) || rate < 0) {
    res.status(400).json({ error: 'hourly_rate must be a number, and not negative' });
    return;
  }

  // A DATE STRING, never a JS Date. `@db.Date` takes the UTC portion, so a
  // Date built at local midnight east of UTC lands on the previous day — the
  // same trap 0033 hit with period_month, and here it would date a raise to
  // the wrong day.
  const from = String(effective_from ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    res.status(400).json({ error: 'effective_from must be a date, as YYYY-MM-DD' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const [row] = await req.tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO public.employee_wages
          (organization_id, user_id, hourly_rate, effective_from, note, set_by)
      VALUES (${membership.organization_id}::uuid, ${user_id}::uuid, ${rate},
              ${from}::date, ${note ? String(note).slice(0, 300) : null}, ${req.userId}::uuid)
      RETURNING id`;

    res.status(201).json({ id: row.id, user_id, hourly_rate: rate, effective_from: from });
  } catch (err) {
    const code = postgresErrorCode(err);

    if (code === '23505') {
      res.status(409).json({
        error: 'A rate already starts on that date for this person',
        code: 'duplicate_effective_date',
      });
      return;
    }
    if (code === '23514') {
      res.status(400).json({ error: 'That rate is not valid' });
      return;
    }
    if (code === '42501') {
      // Covers three different refusals — not a manager, your own rate, or the
      // module is off — and they share a SQLSTATE. Saying which would mean
      // guessing, so this says what to do instead.
      res.status(403).json({
        error:
          'Only an owner or regional manager may set pay, and nobody but the owner may set their own',
        code: 'wage_refused',
      });
      return;
    }

    // eslint-disable-next-line no-console
    console.error('[labour.setWage] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
