import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { SAFETY_CAP } from '../lib/pagination';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') return meta.code;
    // Prisma maps a missing row on update to P2025.
    if (err.code === 'P2025') return 'P2025';
  }
  return undefined;
}

/** The caller's organization: earliest ACTIVE membership — the same rule as GET /api/me. */
async function resolveOrgId(req: Request): Promise<string | null> {
  const membership = await req.tx!.organization_memberships.findFirst({
    where: { user_id: req.userId!, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
}

/** Validates a price: a finite number >= 0 (the DB CHECK also enforces >= 0). */
function priceError(price: unknown): string | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    return 'price must be a number >= 0';
  }
  return null;
}

/**
 * GET /api/catalog/items
 *
 * The organization's menu items (sellable_items), with price. Readable by any
 * member (RLS-scoped via req.tx); managing them is administrative (below).
 */
export async function listItems(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    const items = await req.tx.sellable_items.findMany({
      orderBy: { name: 'asc' },
      take: SAFETY_CAP,
    });
    res.status(200).json(items);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/catalog/items  { name, price, sku? }
 *
 * Creates a menu item in the caller's org. Admin-only: requireRole gates the
 * route and the 0010 RESTRICTIVE require_admin_insert policy is the real
 * backstop. This is where an item's server-authoritative price (used at
 * checkout) is set.
 */
export async function createItem(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as { name?: unknown; price?: unknown; sku?: unknown };

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const pErr = priceError(body.price);
  if (pErr) {
    res.status(400).json({ error: pErr });
    return;
  }
  if (body.sku !== undefined && body.sku !== null && typeof body.sku !== 'string') {
    res.status(400).json({ error: 'sku must be a string' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const item = await req.tx.sellable_items.create({
      data: {
        organization_id: orgId,
        name: body.name.trim(),
        price: body.price as number,
        sku: typeof body.sku === 'string' && body.sku.trim() ? body.sku.trim() : null,
      },
    });

    res.status(201).json(item);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23505') {
      res.status(409).json({ error: 'An item with that SKU already exists' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to manage the menu' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[catalog.create] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/catalog/items/:id  { name?, price?, sku? }
 *
 * Updates a menu item (rename, re-price, change SKU). Admin-only. RLS scopes the
 * update to the caller's org, so a foreign id resolves as not-found (404).
 */
export async function updateItem(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid item id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as { name?: unknown; price?: unknown; sku?: unknown };
  const data: { name?: string; price?: number; sku?: string | null } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    data.name = body.name.trim();
  }
  if (body.price !== undefined) {
    const pErr = priceError(body.price);
    if (pErr) {
      res.status(400).json({ error: pErr });
      return;
    }
    data.price = body.price as number;
  }
  if (body.sku !== undefined) {
    if (body.sku !== null && typeof body.sku !== 'string') {
      res.status(400).json({ error: 'sku must be a string or null' });
      return;
    }
    data.sku = typeof body.sku === 'string' && body.sku.trim() ? body.sku.trim() : null;
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'Provide at least one of: name, price, sku' });
    return;
  }

  try {
    const item = await req.tx.sellable_items.update({ where: { id }, data });
    res.status(200).json(item);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P2025') {
      // Not visible/writable under RLS — indistinguishable from "does not exist".
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    if (code === '23505') {
      res.status(409).json({ error: 'An item with that SKU already exists' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to manage the menu' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[catalog.update] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
