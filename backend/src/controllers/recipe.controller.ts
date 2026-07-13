import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') {
      return meta.code;
    }
  }
  return undefined;
}

/**
 * GET /api/recipes
 *
 * Returns each sellable item with its bill of materials (the recipe lines) and
 * the raw ingredient of each line. Runs on req.tx, so RLS scopes the result to
 * the caller's organization. (The DB calls the recipe lines `bill_of_materials`;
 * the admin frontend maps them to its `recipe_lines` shape.)
 */
export async function getRecipes(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const recipes = await req.tx.sellable_items.findMany({
      include: {
        bill_of_materials: {
          include: { raw_inventory_items: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    res.status(200).json(recipes);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[recipes.get] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/recipes/:id/lines
 *
 * Adds one bill-of-materials line to a sellable item's recipe. The organization
 * is derived from the sellable item itself (RLS-scoped findUnique), so the
 * composite FKs stay consistent and a foreign sellable item is invisible (404).
 */
export async function addRecipeLine(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const sellableItemId = req.params.id;
  const body = (req.body ?? {}) as { raw_item_id?: unknown; quantity_required?: unknown };

  if (typeof sellableItemId !== 'string' || !UUID_RE.test(sellableItemId)) {
    res.status(400).json({ error: 'A valid sellable item id (uuid) is required' });
    return;
  }
  if (typeof body.raw_item_id !== 'string' || !UUID_RE.test(body.raw_item_id)) {
    res.status(400).json({ error: 'raw_item_id (uuid) is required' });
    return;
  }
  if (typeof body.quantity_required !== 'number' || !(body.quantity_required > 0)) {
    res.status(400).json({ error: 'quantity_required must be a positive number' });
    return;
  }

  try {
    const sellable = await req.tx.sellable_items.findUnique({
      where: { id: sellableItemId },
      select: { organization_id: true },
    });
    if (!sellable) {
      res.status(404).json({ error: 'Sellable item not found' });
      return;
    }

    const line = await req.tx.bill_of_materials.create({
      data: {
        organization_id: sellable.organization_id,
        sellable_item_id: sellableItemId,
        raw_item_id: body.raw_item_id,
        quantity_required: body.quantity_required,
      },
    });

    res.status(201).json(line);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[recipes.addLine] failed:', err);
    // Duplicate line (unique), foreign/mismatched raw item (FK), RLS, etc. are
    // all caller errors.
    const pgCode = postgresErrorCode(err);
    if (pgCode) {
      res.status(400).json({ error: 'Could not add recipe line', code: pgCode });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}
