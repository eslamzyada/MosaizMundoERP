import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { parsePage, SAFETY_CAP } from '../lib/pagination';
import {
  isWriteOffReason,
  REASON_REQUIRING_NOTE,
  WRITE_OFF_NOTE_MAX_LENGTH,
  WRITE_OFF_REASONS,
} from '../lib/writeOffReasons';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The PostgreSQL SQLSTATE behind a Prisma error, when the database raised one. */
function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') {
      return meta.code;
    }
    return err.code;
  }
  return undefined;
}

/**
 * POST /api/inventory/write-offs
 *   { raw_item_id, quantity, reason, note?, batch_id? }
 *
 * Records stock discarded outside a sale (0023) — the last route by which
 * inventory could leave without anyone knowing why.
 *
 * `batch_id` is optional and changes the behaviour deliberately: naming a lot
 * draws from that lot alone, which is what expiry requires (you bin the crate
 * that went out of date, not whatever FIFO would have reached for); omitting it
 * draws FIFO like a sale. Neither alone is right for every case.
 *
 * Writing off MORE than the books hold is not an error — it means the books
 * understated what was physically there. The excess is recorded as an inventory
 * deficit and reported back as `quantity_short`, so the caller can say so.
 *
 * Error contract from 0023: P0002 -> 404 (no such ingredient here), 55000 -> 409
 * (named lot is empty), 42501 -> 403 (not a manager), 22023/23514 -> 400.
 */
export async function createWriteOff(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as {
    raw_item_id?: unknown;
    quantity?: unknown;
    reason?: unknown;
    note?: unknown;
    batch_id?: unknown;
  };

  if (typeof body.raw_item_id !== 'string' || !UUID_RE.test(body.raw_item_id)) {
    res.status(400).json({ error: 'raw_item_id (uuid) is required' });
    return;
  }
  if (typeof body.quantity !== 'number' || !Number.isFinite(body.quantity) || body.quantity <= 0) {
    res.status(400).json({ error: 'quantity must be a positive number' });
    return;
  }
  if (!isWriteOffReason(body.reason)) {
    res.status(400).json({
      error: 'reason is required and must be one of the recognised causes',
      allowed: WRITE_OFF_REASONS,
    });
    return;
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    res.status(400).json({ error: 'note must be text' });
    return;
  }
  if (
    body.batch_id !== undefined &&
    body.batch_id !== null &&
    (typeof body.batch_id !== 'string' || !UUID_RE.test(body.batch_id))
  ) {
    res.status(400).json({ error: 'batch_id must be a uuid when given' });
    return;
  }

  const reason = body.reason;
  // Trimmed here as well as in the function so the length check below measures
  // the note that will actually be stored, not its whitespace.
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (reason === REASON_REQUIRING_NOTE && note === '') {
    res.status(400).json({ error: `note is required when reason is '${REASON_REQUIRING_NOTE}'` });
    return;
  }
  if (note.length > WRITE_OFF_NOTE_MAX_LENGTH) {
    res
      .status(400)
      .json({ error: `note must be ${WRITE_OFF_NOTE_MAX_LENGTH} characters or fewer` });
    return;
  }

  const batchId = typeof body.batch_id === 'string' ? body.batch_id : null;

  try {
    // Cast explicitly: note and batch_id may be NULL, and an untyped NULL
    // parameter leaves Postgres unable to resolve the function's signature.
    const rows = await req.tx.$queryRaw<Array<{ id: string }>>`
      SELECT app.write_off_stock(
        ${body.raw_item_id}::uuid,
        ${body.quantity}::numeric,
        ${reason}::text,
        ${note === '' ? null : note}::text,
        ${batchId}::uuid
      ) AS id`;

    const id = rows[0]?.id;
    const created = await req.tx.stock_write_offs.findUnique({
      where: { id },
      include: {
        raw_inventory_items: { select: { name: true, unit_of_measure: true } },
        stock_write_off_lines: true,
      },
    });

    res.status(201).json(created);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P0002') {
      res.status(404).json({ error: 'Ingredient not found in this organization' });
      return;
    }
    if (code === '55000') {
      res.status(409).json({ error: 'That lot has no stock left to write off' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Writing stock off is limited to managers' });
      return;
    }
    if (code === '22023' || code === '23514') {
      res.status(400).json({
        error: 'The write-off was rejected by the database',
        allowed: WRITE_OFF_REASONS,
      });
      return;
    }
    logger.error('inventory.createWriteOff failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/inventory/write-offs?limit=&offset=
 *
 * The log of what has been discarded, newest first, RLS-scoped. Paginated for
 * the same reason order history is: it grows without bound.
 */
export async function listWriteOffs(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const { take, skip } = parsePage(req, { defaultLimit: 100, maxLimit: 200 });
    const writeOffs = await req.tx.stock_write_offs.findMany({
      include: {
        raw_inventory_items: { select: { name: true, unit_of_measure: true } },
        users: { select: { email: true } },
      },
      orderBy: { created_at: 'desc' },
      take,
      skip,
    });
    res.status(200).json(writeOffs);
  } catch (err) {
    logger.error('inventory.listWriteOffs failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

const DEFAULT_EXPIRY_WINDOW = 7;
const MAX_EXPIRY_WINDOW = 365;

/**
 * GET /api/inventory/expiring?days=7
 *
 * Lots that have expired or will within the window, soonest first.
 *
 * inventory_batches.expiry_date has been recorded since 0005 — receiving asks
 * for it, and 0018 goes out of its way to preserve it when a void returns stock
 * to its lot — but until now NOTHING read it. This is the endpoint that makes
 * the column mean something, and it is the preventive half of the write-off
 * feature: seeing what is about to turn is how you avoid having to write it off.
 *
 * Already-expired lots are included rather than filtered out, and flagged. They
 * are the most urgent thing on the list: stock the books still count as sellable
 * that nobody should be cooking with.
 *
 * Lots with no expiry date are excluded — not "unknown, show them anyway" but
 * genuinely not applicable: dry goods and the like never turn.
 */
export async function getExpiringStock(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const raw = Number(req.query.days);
  const days = !Number.isFinite(raw) || raw < 0
    ? DEFAULT_EXPIRY_WINDOW
    : Math.min(Math.floor(raw), MAX_EXPIRY_WINDOW);

  try {
    const lots = await req.tx.$queryRaw`
      SELECT b.id                            AS batch_id,
             b.raw_item_id,
             r.name                          AS item_name,
             r.unit_of_measure,
             b.quantity_remaining,
             b.cost_at_purchase,
             -- What is still on the shelf in this lot is what is at risk; the
             -- part already sold or consumed is not a future loss.
             (b.quantity_remaining * b.cost_at_purchase) AS value_at_risk,
             b.expiry_date,
             s.name                          AS supplier_name,
             b.expiry_date < now()           AS already_expired,
             -- Whole days, floored: "expires in 0 days" reads as today, and a
             -- negative number says how long it has been sitting there expired.
             FLOOR(EXTRACT(EPOCH FROM (b.expiry_date - now())) / 86400)::int AS days_left
      FROM public.inventory_batches b
      JOIN public.raw_inventory_items r ON r.id = b.raw_item_id
      LEFT JOIN public.suppliers s ON s.id = b.supplier_id
      WHERE b.quantity_remaining > 0
        AND b.expiry_date IS NOT NULL
        AND b.expiry_date < now() + make_interval(days => ${days}::int)
      ORDER BY b.expiry_date ASC
      LIMIT ${SAFETY_CAP}
    `;
    res.status(200).json({ days, lots });
  } catch (err) {
    logger.error('inventory.getExpiringStock failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
