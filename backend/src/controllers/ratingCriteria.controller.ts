import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { currentMonth, monthStart } from './rating.controller';
import { cached, contextFor, invalidate } from '../lib/cache';

/**
 * The rubric, and the scores against it (0033).
 *
 * Two resources with deliberately different gates, mirroring the schema:
 *
 *   criteria — read by everybody in the organization, written by administrators.
 *              A standard nobody may read is a standard nobody can meet.
 *   scores   — read AND written by administrators only. It is a judgement of a
 *              named person, and 0027 already made that decision for the overall
 *              rating; this follows it rather than inventing a second rule.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const NOTE_MAX = 500;
const WEIGHT_MAX = 10;

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
  }
  return undefined;
}

/**
 * Whether an error is a uniqueness collision.
 *
 * The typed `create` below raises P2002, which is what the tests exercise. The
 * 23505 branch covers the same collision arriving from a raw statement — it is
 * belt and braces rather than a tested path, and is kept because the cost is a
 * comparison and the cost of missing it is a duplicate name returning a 500.
 */
const isDuplicate = (err: unknown) => {
  const code = postgresErrorCode(err);
  return code === 'P2002' || code === '23505';
};

async function resolveOrgId(req: Request): Promise<string | null> {
  const membership = await req.tx!.organization_memberships.findFirst({
    where: { user_id: req.userId!, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
}

/**
 * The month a request is about, as YYYY-MM. Never a JS Date.
 *
 * period_month is a DATE column. Handing Prisma a Date makes it send the UTC
 * portion, and local midnight anywhere east of UTC is the PREVIOUS day — so
 * "this month" arrives at the database as last month and the 0027 month lock
 * refuses every write, all month, in every timezone ahead of UTC. A string
 * cast to ::date has no timezone to lose. Same approach as the overall rating,
 * using the same exported helpers so the two cannot drift.
 */
function requestedMonth(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}$/.test(raw)) return null;
  const month = Number(raw.slice(5));
  return month >= 1 && month <= 12 ? raw : null;
}

const asNumber = (value: Prisma.Decimal | number) => Number(value);

// ---------------------------------------------------------------------------
// The rubric
// ---------------------------------------------------------------------------

/**
 * GET /api/rating-criteria?include_retired=true
 *
 * Open to every member. Retired criteria are excluded unless asked for: a
 * review sheet should offer what is current, while the settings screen needs to
 * show what can be brought back.
 */
export async function listCriteria(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    const includeRetired = req.query.include_retired === 'true';
    const ctx = await contextFor(req);
    // The variant matters: "with retired" and "without" are different answers
    // to the same url, and sharing one entry would show a retired criterion on
    // a live review sheet.
    const rows = await cached(
      'criteria',
      ctx,
      includeRetired ? 'all' : 'active',
      120,
      async () =>
        req.tx!.rating_criteria.findMany({
          where: includeRetired ? {} : { is_active: true },
          orderBy: [{ is_active: 'desc' }, { sort_order: 'asc' }, { name: 'asc' }],
        }),
    );

    res.status(200).json(
      rows.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        weight: asNumber(c.weight),
        is_active: c.is_active,
        sort_order: c.sort_order,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ratingCriteria.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/rating-criteria  { name, description?, weight?, sort_order? } */
export async function createCriterion(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > NAME_MAX) {
    res.status(400).json({ error: `name is required and must be at most ${NAME_MAX} characters` });
    return;
  }

  const description = typeof body.description === 'string' ? body.description.trim() : null;
  if (description && description.length > DESCRIPTION_MAX) {
    res.status(400).json({ error: `description must be at most ${DESCRIPTION_MAX} characters` });
    return;
  }

  let weight = 1;
  if (body.weight !== undefined) {
    weight = Number(body.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > WEIGHT_MAX) {
      res.status(400).json({ error: `weight must be greater than 0 and at most ${WEIGHT_MAX}` });
      return;
    }
  }

  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(403).json({ error: 'No active organization membership' });
      return;
    }

    const created = await req.tx.rating_criteria.create({
      data: {
        organization_id: orgId,
        name,
        description: description || null,
        weight,
        sort_order: sortOrder,
      },
    });

    await invalidate('criteria', (await contextFor(req)).organizationId ?? '');

    res.status(201).json({
      id: created.id,
      name: created.name,
      description: created.description,
      weight: asNumber(created.weight),
      is_active: created.is_active,
      sort_order: created.sort_order,
    });
  } catch (err) {
    if (isDuplicate(err)) {
      // Named rather than generic: two criteria with the same name make a
      // review sheet ambiguous, and the manager needs to know which one already
      // exists rather than that "something went wrong".
      res.status(409).json({
        error: 'A criterion with this name already exists',
        code: 'duplicate_name',
      });
      return;
    }
    if (postgresErrorCode(err) === '42501') {
      res.status(403).json({ error: 'Changing the criteria is limited to managers' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[ratingCriteria.create] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** PATCH /api/rating-criteria/:id  { name?, description?, weight?, is_active?, sort_order? } */
export async function updateCriterion(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Prisma.rating_criteriaUpdateInput = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0 || name.length > NAME_MAX) {
      res.status(400).json({ error: `name must be between 1 and ${NAME_MAX} characters` });
      return;
    }
    patch.name = name;
  }

  if (body.description !== undefined) {
    if (body.description === null) {
      patch.description = null;
    } else {
      const description = String(body.description).trim();
      if (description.length > DESCRIPTION_MAX) {
        res.status(400).json({ error: `description must be at most ${DESCRIPTION_MAX} characters` });
        return;
      }
      patch.description = description || null;
    }
  }

  if (body.weight !== undefined) {
    const weight = Number(body.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > WEIGHT_MAX) {
      res.status(400).json({ error: `weight must be greater than 0 and at most ${WEIGHT_MAX}` });
      return;
    }
    patch.weight = weight;
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active must be true or false' });
      return;
    }
    patch.is_active = body.is_active;
  }

  if (body.sort_order !== undefined) {
    const sortOrder = Number(body.sort_order);
    if (!Number.isInteger(sortOrder)) {
      res.status(400).json({ error: 'sort_order must be a whole number' });
      return;
    }
    patch.sort_order = sortOrder;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  try {
    // updateMany, not update: RLS scopes it to this organization, so a criterion
    // belonging to somebody else matches zero rows and answers 404 rather than
    // confirming that it exists.
    const result = await req.tx.rating_criteria.updateMany({
      where: { id: req.params.id },
      data: patch,
    });

    if (result.count === 0) {
      res.status(404).json({ error: 'Criterion not found' });
      return;
    }

    await invalidate('criteria', (await contextFor(req)).organizationId ?? '');

    const updated = await req.tx.rating_criteria.findFirst({ where: { id: req.params.id } });
    res.status(200).json(
      updated && {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        weight: asNumber(updated.weight),
        is_active: updated.is_active,
        sort_order: updated.sort_order,
      },
    );
  } catch (err) {
    if (isDuplicate(err)) {
      res.status(409).json({
        error: 'A criterion with this name already exists',
        code: 'duplicate_name',
      });
      return;
    }
    if (postgresErrorCode(err) === '42501') {
      res.status(403).json({ error: 'Changing the criteria is limited to managers' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[ratingCriteria.update] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/rating-criteria/:id
 *
 * Only ever succeeds for a criterion nobody has been scored against. Once it
 * has been used it is history, and the answer is a 409 pointing at the thing
 * that does work — retiring it — rather than an opaque foreign key error.
 */
export async function deleteCriterion(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  try {
    const result = await req.tx.rating_criteria.deleteMany({ where: { id: req.params.id } });
    if (result.count === 0) {
      res.status(404).json({ error: 'Criterion not found' });
      return;
    }
    await invalidate('criteria', (await contextFor(req)).organizationId ?? '');
    res.status(204).end();
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P2003' || code === '23503') {
      res.status(409).json({
        error:
          'This criterion has already been used in a review. Retire it instead — its history stays intact.',
        code: 'criterion_in_use',
      });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Changing the criteria is limited to managers' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[ratingCriteria.delete] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// The scores
// ---------------------------------------------------------------------------

/**
 * GET /api/rating-criteria/scores?month=YYYY-MM&employee_id=
 *
 * Administrators only. Returns the scores AND the weighted average, so the
 * caller does not have to re-derive a figure the server already knows how to
 * compute — and so two clients cannot compute it differently.
 */
export async function listCriterionScores(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const month = requestedMonth(req.query.month) ?? currentMonth();
  const employeeId = typeof req.query.employee_id === 'string' ? req.query.employee_id : undefined;
  if (employeeId && !UUID_RE.test(employeeId)) {
    res.status(400).json({ error: 'employee_id must be a uuid' });
    return;
  }

  try {
    // Raw, with the month as a STRING cast to ::date — see requestedMonth for
    // why a JS Date must not come near this column.
    const rows = await req.tx.$queryRaw<
      Array<{
        employee_id: string;
        criterion_id: string;
        criterion_name: string;
        criterion_is_active: boolean;
        weight: Prisma.Decimal;
        score: number;
        note: string | null;
      }>
    >`
      SELECT s.employee_id::text,
             s.criterion_id::text,
             c.name       AS criterion_name,
             c.is_active  AS criterion_is_active,
             c.weight,
             s.score,
             s.note
        FROM public.employee_criterion_scores s
        JOIN public.rating_criteria c ON c.id = s.criterion_id
       WHERE s.period_month = ${monthStart(month)}::date
         AND (${employeeId ?? null}::uuid IS NULL OR s.employee_id = ${employeeId ?? null}::uuid)
       ORDER BY c.sort_order, c.name`;

    const byEmployee = new Map<
      string,
      {
        employee_id: string;
        scores: Array<Record<string, unknown>>;
        weighted: number;
        weight: number;
      }
    >();

    for (const row of rows) {
      const entry = byEmployee.get(row.employee_id) ?? {
        employee_id: row.employee_id,
        scores: [],
        weighted: 0,
        weight: 0,
      };
      const weight = asNumber(row.weight);
      entry.scores.push({
        criterion_id: row.criterion_id,
        criterion_name: row.criterion_name,
        criterion_is_active: row.criterion_is_active,
        weight,
        score: row.score,
        note: row.note,
      });
      entry.weighted += row.score * weight;
      entry.weight += weight;
      byEmployee.set(row.employee_id, entry);
    }

    res.status(200).json({
      month,
      /** True while this month can still be written to. */
      is_open: month === currentMonth(),
      employees: [...byEmployee.values()].map((e) => ({
        employee_id: e.employee_id,
        scores: e.scores,
        /**
         * Reported BESIDE the manager's overall rating, never instead of it.
         * Where the two disagree is the interesting part of a review.
         */
        weighted_average: e.weight > 0 ? Math.round((e.weighted / e.weight) * 100) / 100 : null,
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ratingCriteria.listScores] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PUT /api/rating-criteria/scores  { employee_id, criterion_id, score, note? }
 *
 * PUT rather than POST: there is one score per person per criterion per month,
 * so sending it again is a revision, not a second opinion. The month is never
 * taken from the caller — only the current one is writable, and the trigger
 * would refuse anything else anyway.
 */
export async function upsertCriterionScore(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const employeeId = typeof body.employee_id === 'string' ? body.employee_id : '';
  const criterionId = typeof body.criterion_id === 'string' ? body.criterion_id : '';

  if (!UUID_RE.test(employeeId) || !UUID_RE.test(criterionId)) {
    res.status(400).json({ error: 'employee_id and criterion_id must be uuids' });
    return;
  }

  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    res.status(400).json({ error: 'score must be a whole number between 1 and 5' });
    return;
  }

  const note = typeof body.note === 'string' ? body.note.trim() : null;
  if (note && note.length > NOTE_MAX) {
    res.status(400).json({ error: `note must be at most ${NOTE_MAX} characters` });
    return;
  }

  if (employeeId === req.userId) {
    // Refused here as well as by the CHECK, so the answer is a sentence rather
    // than a constraint name.
    res.status(400).json({ error: 'Nobody scores themselves' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(403).json({ error: 'No active organization membership' });
      return;
    }

    const month = currentMonth();
    await req.tx.$executeRaw`
      INSERT INTO public.employee_criterion_scores
          (organization_id, employee_id, rated_by, criterion_id, period_month, score, note)
      VALUES (${orgId}::uuid, ${employeeId}::uuid, ${req.userId}::uuid,
              ${criterionId}::uuid, ${monthStart(month)}::date, ${score}, ${note})
      ON CONFLICT (organization_id, employee_id, period_month, criterion_id) DO UPDATE
          SET score    = EXCLUDED.score,
              note     = EXCLUDED.note,
              rated_by = EXCLUDED.rated_by`;

    res.status(200).json({
      criterion_id: criterionId,
      employee_id: employeeId,
      score,
      note,
      period_month: month,
    });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P2003' || code === '23503') {
      // Either the criterion does not exist or it belongs to another
      // organization — and the composite key means those are the same answer.
      res.status(404).json({ error: 'Criterion not found' });
      return;
    }
    if (code === '55000') {
      res.status(409).json({
        error: 'That month is closed; only the current month can be scored',
        code: 'month_closed',
      });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Scoring is limited to managers' });
      return;
    }
    if (code === '23514') {
      res.status(400).json({ error: 'The score was rejected by the database' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[ratingCriteria.upsertScore] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
