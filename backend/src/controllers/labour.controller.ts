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
    const rows = await req.tx.$queryRaw<Array<{ user_id: string; minutes: number; entries: number }>>`
      SELECT t.user_id,
             -- An entry still open counts up to now, so today's total is not
             -- a lie by omission while somebody is still on the floor.
             COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at, now()) - t.started_at)) / 60), 0)::int
               AS minutes,
             COUNT(*)::int AS entries
        FROM public.time_entries t
       WHERE t.started_at >= ${range.from}
         AND t.started_at < ${range.to}
       GROUP BY t.user_id
       ORDER BY minutes DESC`;

    res.status(200).json({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      by_employee: rows.map((r) => ({
        user_id: r.user_id,
        minutes: Number(r.minutes),
        hours: Math.round((Number(r.minutes) / 60) * 100) / 100,
        entries: Number(r.entries),
      })),
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
