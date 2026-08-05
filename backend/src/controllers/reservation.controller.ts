import { Request, Response } from 'express';
import { resolveMembership } from '../middleware/requireRole';
import { postgresErrorCode } from '../lib/postgresError';

/**
 * Tables and the promises made about them (0039).
 *
 * Double-booking is refused by an EXCLUDE constraint, not by this file. What
 * this file must do is turn that refusal into a sentence a host can act on
 * while a guest is on the phone — "that table is taken then" — rather than a
 * 500 that tells them to call back.
 *
 * The availability check calls app.table_is_free, which shares its predicate
 * with the constraint. Computing availability here in JavaScript would be a
 * second opinion, and the two would diverge the first time somebody changed
 * one of them.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUSES = ['booked', 'seated', 'completed', 'no_show', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

function serviceWindow(req: Request): { from: Date; to: Date } | null {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date();
  const to = req.query.to
    ? new Date(String(req.query.to))
    : new Date(from.getTime() + 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  return { from, to };
}

/** GET /api/reservations/tables — the floor plan. */
export async function listTables(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    const rows = await req.tx.restaurant_tables.findMany({
      where: req.query.all === 'true' ? {} : { is_active: true },
      orderBy: [{ area: 'asc' }, { label: 'asc' }],
    });
    res.status(200).json(rows);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reservations.listTables] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/reservations/tables — define a table. Managers only. */
export async function createTable(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  const { label, area, seats } = req.body ?? {};
  if (!label || String(label).trim().length === 0) {
    res.status(400).json({ error: 'A table needs a label' });
    return;
  }
  const seatCount = Number(seats ?? 2);
  if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 40) {
    res.status(400).json({ error: 'seats must be between 1 and 40' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const table = await req.tx.restaurant_tables.create({
      data: {
        organization_id: membership.organization_id,
        label: String(label).trim(),
        area: area ? String(area).trim() : null,
        seats: seatCount,
      },
    });
    res.status(201).json(table);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23505' || code === 'P2002') {
      res.status(409).json({ error: 'A table with that label already exists', code: 'duplicate_label' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Only a manager may change the floor plan' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[reservations.createTable] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** PATCH /api/reservations/tables/:id — rename, re-seat, or retire. */
export async function updateTable(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  const data: Record<string, unknown> = {};
  if (req.body?.label !== undefined) data.label = String(req.body.label).trim();
  if (req.body?.area !== undefined) data.area = req.body.area ? String(req.body.area).trim() : null;
  if (req.body?.seats !== undefined) data.seats = Number(req.body.seats);
  // Retiring, not deleting: a table that has held bookings is part of the
  // record of them.
  if (req.body?.is_active !== undefined) data.is_active = Boolean(req.body.is_active);

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'Nothing to change' });
    return;
  }

  try {
    const result = await req.tx.restaurant_tables.updateMany({ where: { id: req.params.id }, data });
    if (result.count === 0) {
      res.status(404).json({ error: 'No such table' });
      return;
    }
    res.status(200).json({ id: req.params.id, updated: true });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23505') {
      res.status(409).json({ error: 'A table with that label already exists', code: 'duplicate_label' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Only a manager may change the floor plan' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[reservations.updateTable] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/reservations?from=&to= — the book for a service. */
export async function listReservations(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  const range = serviceWindow(req);
  if (!range) {
    res.status(400).json({ error: 'from and to must be dates, and to must be after from' });
    return;
  }

  try {
    const rows = await req.tx.reservations.findMany({
      where: { starts_at: { gte: range.from, lt: range.to } },
      orderBy: { starts_at: 'asc' },
    });
    res.status(200).json(rows);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reservations.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/reservations/availability?table_id=&starts_at=&ends_at=
 *
 * Asks the database, which asks the same predicate the constraint uses. A host
 * told "free" by one rule and refused by another is a guest in the doorway.
 */
export async function availability(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  const tableId = String(req.query.table_id ?? '');
  const startsAt = new Date(String(req.query.starts_at));
  const endsAt = new Date(String(req.query.ends_at));
  if (!UUID_RE.test(tableId) || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    res.status(400).json({ error: 'table_id, starts_at and ends_at are required' });
    return;
  }

  try {
    const [row] = await req.tx.$queryRaw<Array<{ free: boolean }>>`
      SELECT app.table_is_free(${tableId}::uuid, ${startsAt}::timestamptz, ${endsAt}::timestamptz) AS free`;
    res.status(200).json({ free: row.free });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reservations.availability] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/reservations — take a booking. Floor work, not administration. */
export async function createReservation(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const { table_id, guest_name, guest_phone, party_size, starts_at, ends_at, note } = req.body ?? {};
  if (!UUID_RE.test(String(table_id ?? ''))) {
    res.status(400).json({ error: 'table_id must be a uuid' });
    return;
  }
  if (!guest_name || String(guest_name).trim().length < 2) {
    res.status(400).json({ error: 'A booking needs a name' });
    return;
  }
  const party = Number(party_size);
  if (!Number.isInteger(party) || party < 1 || party > 40) {
    res.status(400).json({ error: 'party_size must be between 1 and 40' });
    return;
  }
  const start = new Date(String(starts_at));
  const end = new Date(String(ends_at));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    res.status(400).json({ error: 'starts_at and ends_at must be timestamps, and it must end after it starts' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const booking = await req.tx.reservations.create({
      data: {
        organization_id: membership.organization_id,
        table_id: String(table_id),
        guest_name: String(guest_name).trim(),
        guest_phone: guest_phone ? String(guest_phone).trim() : null,
        party_size: party,
        starts_at: start,
        ends_at: end,
        note: note ? String(note).slice(0, 500) : null,
        created_by: req.userId,
      },
    });
    res.status(201).json(booking);
  } catch (err) {
    res.status(mapBookingError(err)).json(bookingBody(err));
  }
}

/**
 * POST /api/reservations/:id/status  { status }
 *
 * Seated, finished, no-show, cancelled. There is no delete: a booking that did
 * not happen is exactly the thing a restaurant needs to be able to count.
 */
export async function setStatus(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }
  const status = String(req.body?.status ?? '') as Status;
  if (!STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    return;
  }

  try {
    const result = await req.tx.reservations.updateMany({
      where: { id: req.params.id },
      data: { status },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'No such booking' });
      return;
    }
    res.status(200).json({ id: req.params.id, status });
  } catch (err) {
    res.status(mapBookingError(err)).json(bookingBody(err));
  }
}

function mapBookingError(err: unknown): number {
  const code = postgresErrorCode(err);
  if (code === '23P01') return 409; // exclusion — double booking
  if (code === '23503') return 409; // the table is not this tenant's
  if (code === '23514') return 400; // shape
  if (code === '42501') return 403;
  return 500;
}

function bookingBody(err: unknown): Record<string, unknown> {
  const code = postgresErrorCode(err);
  if (code === '23P01') {
    return {
      error: 'That table is already promised to somebody for part of that time',
      code: 'double_booking',
    };
  }
  if (code === '23503') {
    return { error: 'That table does not belong to this restaurant', code: 'unknown_table' };
  }
  if (code === '23514') {
    return { error: 'A sitting must end after it starts, and last at most 8 hours' };
  }
  if (code === '42501') {
    return { error: 'You are not allowed to take bookings' };
  }
  // eslint-disable-next-line no-console
  console.error('[reservations] failed:', err);
  return { error: 'Internal server error' };
}
