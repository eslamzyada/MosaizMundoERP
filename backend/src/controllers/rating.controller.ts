import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** YYYY-MM — a rating covers a calendar month, never a range. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const NOTE_MAX_LENGTH = 1000;

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
  }
  return undefined;
}

/** The first day of a YYYY-MM, as the date the column stores. */
function monthStart(month: string): string {
  return `${month}-01`;
}

/** The current month in YYYY-MM, in the server's local calendar. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * PUT /api/ratings  { employee_id, period_month, score, note? }
 *
 * Records a manager's judgement of one employee for one calendar month (0027).
 *
 * PUT rather than POST because there is exactly one rating per person per month
 * and re-submitting is a revision, not a second opinion. The upsert makes that
 * literal: the same call creates or revises, and the caller does not have to
 * know which.
 *
 * Only the CURRENT month is writable. A closed month is history, and letting it
 * be edited would allow last quarter's verdicts to be revised after seeing this
 * quarter's numbers. The database enforces that with a trigger; this endpoint
 * only translates the refusal, because a rule that lives in a controller is
 * bypassed by the next controller somebody writes.
 *
 * Gated to ADMIN_ROLES by the route, and — unusually for this schema — by a
 * RESTRICTIVE policy that covers SELECT as well, so a cashier cannot read
 * ratings at all, including their own.
 */
export async function upsertRating(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as {
    employee_id?: unknown;
    period_month?: unknown;
    score?: unknown;
    note?: unknown;
  };

  if (typeof body.employee_id !== 'string' || !UUID_RE.test(body.employee_id)) {
    res.status(400).json({ error: 'employee_id (uuid) is required' });
    return;
  }
  if (typeof body.period_month !== 'string' || !MONTH_RE.test(body.period_month)) {
    res.status(400).json({ error: 'period_month must be a month in YYYY-MM form' });
    return;
  }
  if (
    typeof body.score !== 'number' ||
    !Number.isInteger(body.score) ||
    body.score < 1 ||
    body.score > 5
  ) {
    // A five-point scale on purpose: nobody can defend the difference between
    // a 6 and a 7 on a ten-point one.
    res.status(400).json({ error: 'score must be a whole number from 1 to 5' });
    return;
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    res.status(400).json({ error: 'note must be text' });
    return;
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > NOTE_MAX_LENGTH) {
    res.status(400).json({ error: `note must be ${NOTE_MAX_LENGTH} characters or fewer` });
    return;
  }

  // Answered here as well as by the trigger, so the caller gets a sentence
  // rather than a SQLSTATE for the most likely mistake.
  if (body.period_month !== currentMonth()) {
    res.status(409).json({
      error: `Only the current month (${currentMonth()}) can be rated; earlier months are closed`,
      current_month: currentMonth(),
    });
    return;
  }

  if (body.employee_id === req.userId) {
    res.status(400).json({ error: 'You cannot rate yourself' });
    return;
  }

  try {
    // The employee must be a member of the caller's organization. Resolved
    // through the membership under RLS, so someone in another tenant is simply
    // not there — and the organization_id comes from the membership rather than
    // from the request, which is what stops a rating being filed against
    // another tenant's org.
    const membership = await req.tx.organization_memberships.findFirst({
      where: { user_id: body.employee_id },
      select: { organization_id: true },
    });
    if (!membership) {
      res.status(404).json({ error: 'That employee is not a member of this organization' });
      return;
    }

    const rows = await req.tx.$queryRaw<Array<Record<string, unknown>>>`
      INSERT INTO public.employee_ratings
        (organization_id, employee_id, rated_by, period_month, score, note)
      VALUES (${membership.organization_id}::uuid, ${body.employee_id}::uuid,
              ${req.userId}::uuid, ${monthStart(body.period_month)}::date,
              ${body.score}::smallint, ${note === '' ? null : note}::text)
      ON CONFLICT (organization_id, employee_id, period_month) DO UPDATE
        SET score    = EXCLUDED.score,
            note     = EXCLUDED.note,
            -- The reviser becomes the author: the current judgement is theirs.
            rated_by = EXCLUDED.rated_by
      RETURNING id, employee_id, period_month, score, note, rated_by, updated_at`;

    res.status(200).json(rows[0]);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '55000') {
      res.status(409).json({ error: 'That month is closed and can no longer be rated' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Recording a rating is limited to managers' });
      return;
    }
    if (code === '23514') {
      res.status(400).json({ error: 'That rating was rejected by the database' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[ratings.upsert] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/ratings?month=YYYY-MM
 *
 * Ratings for one month, or the most recent per employee when no month is
 * given. Manager-only — the RESTRICTIVE policy means a cashier requesting this
 * would see an empty list rather than their own rating, but the route is gated
 * too so they get an honest 403 instead of a confusing blank.
 */
export async function listRatings(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const month = req.query.month;
  if (month !== undefined && (typeof month !== 'string' || !MONTH_RE.test(month))) {
    res.status(400).json({ error: 'month must be in YYYY-MM form' });
    return;
  }

  try {
    const ratings = await req.tx.$queryRaw`
      SELECT r.id,
             r.employee_id,
             u.email          AS employee_email,
             r.period_month,
             r.score,
             r.note,
             r.rated_by,
             a.email          AS rated_by_email,
             r.updated_at,
             -- Whether it can still be changed, so the UI does not have to
             -- reimplement the lock and get it subtly different.
             (r.period_month = date_trunc('month', now())::date) AS is_editable
      FROM public.employee_ratings r
      JOIN public.users u ON u.id = r.employee_id
      LEFT JOIN public.users a ON a.id = r.rated_by
      ${
        typeof month === 'string'
          ? Prisma.sql`WHERE r.period_month = ${monthStart(month)}::date`
          : Prisma.empty
      }
      ORDER BY r.period_month DESC, u.email ASC
      LIMIT 500`;

    res.status(200).json({ current_month: currentMonth(), ratings });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ratings.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
