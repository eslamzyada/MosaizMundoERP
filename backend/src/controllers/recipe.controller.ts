import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { SAFETY_CAP } from '../lib/pagination';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The failure code for a database error, whichever form Prisma reports it in.
 * A raw query carries the Postgres SQLSTATE in `meta.code` (e.g. '23505'), but
 * a typed create/update/delete reports Prisma's own code instead ('P2002' for a
 * unique violation, 'P2025' for a row that isn't there / was filtered out by
 * RLS). Callers must therefore match on both spellings.
 */
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
      take: SAFETY_CAP,
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
    const code = postgresErrorCode(err);
    // The ingredient is already on this recipe. That is not a failure the user
    // should have to decode — the line exists, so it is edited, not re-added.
    if (code === '23505' || code === 'P2002') {
      res.status(409).json({ error: 'That ingredient is already in this recipe' });
      return;
    }
    // The raw item doesn't exist, or belongs to another organization: the
    // composite FK to (id, organization_id) is what catches the cross-tenant case.
    if (code === '23503' || code === 'P2003') {
      res.status(400).json({ error: 'Ingredient not found in this organization' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to edit recipes' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[recipes.addLine] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/recipes/lines/:lineId  { quantity_required }
 *
 * Changes how much of an ingredient a dish consumes — the number that drives
 * food cost and how much stock a sale draws down. Only the quantity is
 * editable: swapping the ingredient itself is a remove plus an add, which keeps
 * the (org, sellable, raw) unique constraint meaningful.
 *
 * Admin-only. RLS scopes the update to the caller's organization, so a line
 * belonging to another tenant is simply not there (404).
 */
export async function updateRecipeLine(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const lineId = req.params.lineId;
  if (typeof lineId !== 'string' || !UUID_RE.test(lineId)) {
    res.status(400).json({ error: 'A valid recipe line id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as { quantity_required?: unknown };
  if (typeof body.quantity_required !== 'number' || !(body.quantity_required > 0)) {
    // The DB CHECK (quantity_required > 0) says the same thing; rejecting here
    // gives a readable message instead of a constraint name.
    res.status(400).json({ error: 'quantity_required must be a positive number' });
    return;
  }

  try {
    const line = await req.tx.bill_of_materials.update({
      where: { id: lineId },
      data: { quantity_required: body.quantity_required },
    });
    res.status(200).json(line);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P2025') {
      res.status(404).json({ error: 'Recipe line not found' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to edit recipes' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[recipes.updateLine] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/recipes/lines/:lineId
 *
 * Takes an ingredient back out of a recipe. Not retroactive: past sales and the
 * stock they already drew down are recorded in sale_items and inventory_batches
 * and are untouched — only future checkouts stop consuming this ingredient.
 *
 * Admin-only, enforced by requireRole and, as the real backstop, the
 * require_admin_delete RESTRICTIVE policy added in migration 0014. Without that
 * policy the DELETE privilege would fall through to the permissive
 * org-membership policy and any member could edit recipes.
 */
export async function deleteRecipeLine(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const lineId = req.params.lineId;
  if (typeof lineId !== 'string' || !UUID_RE.test(lineId)) {
    res.status(400).json({ error: 'A valid recipe line id (uuid) is required' });
    return;
  }

  try {
    await req.tx.bill_of_materials.delete({ where: { id: lineId } });
    res.status(204).send();
  } catch (err) {
    const code = postgresErrorCode(err);
    // Not there, or filtered out by RLS — indistinguishable on purpose, so a
    // caller cannot probe another tenant's line ids.
    if (code === 'P2025') {
      res.status(404).json({ error: 'Recipe line not found' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to edit recipes' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[recipes.deleteLine] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
