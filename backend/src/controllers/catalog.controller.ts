import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { SAFETY_CAP } from '../lib/pagination';
import { costRecipe, rawItemIdsOf, unitCostsByRawItem } from '../lib/foodCost';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    // Raw queries carry the Postgres SQLSTATE in meta.code; typed operations
    // (create/update) surface Prisma's own code — P2002 (unique), P2025 (not found).
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
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
 * The organization's menu items (sellable_items), with price AND what each one
 * costs to make. Readable by any member (RLS-scoped via req.tx); managing them
 * is administrative (below).
 *
 * Cost is included because this is where prices are set: pricing a dish without
 * knowing its food cost is guesswork. It uses the shared `lib/foodCost` basis,
 * so this screen and the recipe editor can never disagree.
 *
 * Three states the caller must keep apart, none of which is "cost 0":
 *   recipe_line_count = 0      -> no recipe at all; the cost is UNKNOWN
 *   uncosted_line_count > 0    -> partially priced; total_cost is a floor
 *   otherwise                  -> total_cost is the real food cost
 * The recipe lines themselves are not returned — the menu only needs the totals.
 */
export async function listItems(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    const items = await req.tx.sellable_items.findMany({
      include: {
        bill_of_materials: { select: { raw_item_id: true, quantity_required: true } },
      },
      orderBy: { name: 'asc' },
      take: SAFETY_CAP,
    });

    const unitCostOf = await unitCostsByRawItem(req.tx, rawItemIdsOf(items));

    const costed = items.map(({ bill_of_materials, ...item }) => ({
      ...item,
      ...costRecipe(bill_of_materials, unitCostOf),
    }));

    res.status(200).json(costed);
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
  // Since 0035 the menu is not editable. The application role has no INSERT or
  // UPDATE on sellable_items, so this endpoint cannot do what it used to even
  // if it tried — and a 500 from a revoked privilege would tell a manager
  // nothing. It answers with the route that does work instead.
  res.status(409).json({
    error:
      'The menu can only be changed through an approved request. Propose the change at POST /api/menu-changes.',
    code: 'menu_change_required',
    propose_at: '/api/menu-changes',
  });
  void req;
}

/**
 * PATCH /api/catalog/items/:id  { name?, price?, sku? }
 *
 * Updates a menu item (rename, re-price, change SKU). Admin-only. RLS scopes the
 * update to the caller's org, so a foreign id resolves as not-found (404).
 */
export async function updateItem(req: Request, res: Response): Promise<void> {
  // Since 0035 the menu is not editable. The application role has no INSERT or
  // UPDATE on sellable_items, so this endpoint cannot do what it used to even
  // if it tried — and a 500 from a revoked privilege would tell a manager
  // nothing. It answers with the route that does work instead.
  res.status(409).json({
    error:
      'The menu can only be changed through an approved request. Propose the change at POST /api/menu-changes.',
    code: 'menu_change_required',
    propose_at: '/api/menu-changes',
  });
  void req;
}
