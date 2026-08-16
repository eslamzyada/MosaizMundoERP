import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { resolveMembership } from '../middleware/requireRole';
import { postgresErrorCode } from '../lib/postgresError';

/**
 * The staff side of public ordering (0040).
 *
 * Accepting is where a stranger's request becomes a sale, and it happens here
 * under the staff member's own identity — app.accept_public_order is SECURITY
 * INVOKER, so their role, their RLS and the ordinary checkout path all apply.
 * This controller does not get to shortcut any of that.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/public-orders?status=pending — the queue. */
export async function listQueue(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const status = req.query.status ? String(req.query.status) : 'pending';

  try {
    // No organization filter: the org policy scopes this, and a filter here
    // would be a second rule that can disagree with it.
    const rows = await req.tx.public_orders.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { created_at: 'desc' },
      take: 100,
      include: { public_order_lines: true },
    });

    res.status(200).json(
      rows.map((o) => ({
        id: o.id,
        customer_name: o.customer_name,
        customer_phone: o.customer_phone,
        note: o.note,
        status: o.status,
        quoted_total: o.quoted_total,
        created_at: o.created_at,
        decided_at: o.decided_at,
        rejection_reason: o.rejection_reason,
        accepted_order_id: o.accepted_order_id,
        lines: o.public_order_lines.map((l) => ({
          item_name: l.item_name,
          quantity: l.quantity,
          unit_price: l.unit_price,
        })),
      })),
    );
  } catch (err) {
    logger.error('publicOrders.list failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/public-orders/:id/accept — turn it into a real sale. */
export async function accept(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  try {
    const [row] = await req.tx.$queryRaw<Array<{ accept_public_order: string }>>`
      SELECT app.accept_public_order(${req.params.id}::uuid) AS accept_public_order`;

    res.status(200).json({ id: req.params.id, order_id: row.accept_public_order });
  } catch (err) {
    const code = postgresErrorCode(err);

    if (code === 'P0002' || code === '02000') {
      // Not ours, or not there. The same answer either way — telling a caller
      // which would confirm the existence of another restaurant's request.
      res.status(404).json({ error: 'No such request' });
      return;
    }
    if (code === '55000') {
      res.status(409).json({ error: 'That request has already been decided', code: 'already_decided' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'You are not allowed to accept orders' });
      return;
    }
    // Anything the checkout itself refused — out of stock, a retired dish —
    // arrives here. It is the caller's problem to see, not a 500.
    if (code === '23514' || code === '23503' || code === 'P0001') {
      res.status(409).json({
        error: 'That order could not be put through the till',
        code: 'checkout_refused',
      });
      return;
    }

    logger.error('publicOrders.accept failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/public-orders/:id/reject  { reason } */
export async function reject(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  const reason = String(req.body?.reason ?? '').trim();
  if (reason.length < 3) {
    res.status(400).json({ error: 'A rejection needs a reason' });
    return;
  }

  try {
    await req.tx.$queryRaw`SELECT app.reject_public_order(${req.params.id}::uuid, ${reason})`;
    res.status(200).json({ id: req.params.id, status: 'rejected' });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P0002' || code === '02000') {
      res.status(404).json({ error: 'No pending request with that id' });
      return;
    }
    if (code === '22023') {
      res.status(400).json({ error: 'A rejection needs a reason' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'You are not allowed to decide orders' });
      return;
    }
    logger.error('publicOrders.reject failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/public-orders/storefront — this tenant's own shopfront. */
export async function getStorefront(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    const row = await req.tx.storefronts.findFirst();
    res.status(200).json(row ?? null);
  } catch (err) {
    logger.error('publicOrders.storefront failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** PUT /api/public-orders/storefront — open, close, or name the shopfront. */
export async function saveStorefront(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const { slug, display_name, greeting, is_accepting } = req.body ?? {};

  const membership = await resolveMembership(req);
  if (!membership) {
    res.status(404).json({ error: 'No active organization membership found for this user' });
    return;
  }

  try {
    const existing = await req.tx.storefronts.findFirst();

    if (!existing) {
      if (!slug || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(slug))) {
        res.status(400).json({
          error: 'A shopfront needs a web address: lowercase letters, numbers and dashes',
          code: 'invalid_slug',
        });
        return;
      }
      if (!display_name || String(display_name).trim().length < 2) {
        res.status(400).json({ error: 'A shopfront needs a name to show customers' });
        return;
      }

      const created = await req.tx.storefronts.create({
        data: {
          organization_id: membership.organization_id,
          slug: String(slug),
          display_name: String(display_name).trim(),
          greeting: greeting ? String(greeting).slice(0, 300) : null,
          is_accepting: Boolean(is_accepting),
        },
      });
      res.status(201).json(created);
      return;
    }

    const data: Record<string, unknown> = {};
    if (slug !== undefined) data.slug = String(slug);
    if (display_name !== undefined) data.display_name = String(display_name).trim();
    if (greeting !== undefined) data.greeting = greeting ? String(greeting).slice(0, 300) : null;
    if (is_accepting !== undefined) data.is_accepting = Boolean(is_accepting);

    const updated = await req.tx.storefronts.update({
      where: { organization_id: existing.organization_id },
      data,
    });
    res.status(200).json(updated);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23505' || code === 'P2002') {
      res.status(409).json({
        error: 'That web address is taken by another restaurant',
        code: 'slug_taken',
      });
      return;
    }
    if (code === '23514') {
      res.status(400).json({
        error: 'A web address may contain only lowercase letters, numbers and dashes',
        code: 'invalid_slug',
      });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Only a manager may change the shopfront' });
      return;
    }
    logger.error('publicOrders.saveStorefront failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
