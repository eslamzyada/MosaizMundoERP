import { Router, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma';

/**
 * The only unauthenticated surface in this API (0040).
 *
 * Every other router begins with authMiddleware, which opens a transaction and
 * binds app.current_user_id so RLS can do its job. Nothing here does, because
 * a customer has no identity — so this router deliberately uses the GLOBAL
 * prisma client with no identity bound, and can therefore reach nothing but
 * three SECURITY DEFINER functions. RLS refuses every table to it.
 *
 * That is the safety property, and it is worth stating plainly: if somebody
 * later adds a `prisma.orders.findMany()` to this file, it returns zero rows
 * rather than leaking, because the connection has no identity. The failure
 * mode of a mistake here is emptiness, not exposure.
 *
 * Mounted at /public, NOT under /api — the whole point is that it is a
 * different kind of thing, and a router mounted under /api would be one
 * refactor away from inheriting an auth middleware that does not apply.
 */
const router = Router();

// A customer's browser is on whatever origin the restaurant put its page on,
// which the CORS_ORIGINS allow-list cannot know. These endpoints are readable
// by anyone by design, so the allow-list would be protecting nothing.
router.use(cors({ origin: true }));

// Tighter than the global limiter, and per route group: reading a menu is
// cheap, filing an order writes rows.
const readLimit = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.PUBLIC_READ_RATE_LIMIT) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

const writeLimit = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.PUBLIC_ORDER_RATE_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many orders from this address. Please try again shortly.' },
});

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /public/:slug/menu
 *
 * An unknown slug, a closed shop and a restaurant that does not do this at all
 * all answer 404 with the same body. Distinguishing them would turn this into
 * a directory of who uses the product.
 */
router.get('/:slug/menu', readLimit, async (req: Request, res: Response) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_RE.test(slug)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    const rows = await prisma.$queryRaw<
      Array<{ item_id: string; name: string; price: unknown; restaurant: string; greeting: string | null }>
    >`SELECT * FROM app.public_menu(${slug})`;

    if (rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).json({
      restaurant: rows[0].restaurant,
      greeting: rows[0].greeting,
      items: rows.map((r) => ({ id: r.item_id, name: r.name, price: Number(r.price) })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[public.menu] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /public/:slug/orders
 *
 * The body carries item ids and quantities. It may also carry prices — they
 * are not read. The procedure prices every line from the menu.
 */
router.post('/:slug/orders', writeLimit, async (req: Request, res: Response) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_RE.test(slug)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const { name, phone, note, items } = req.body ?? {};
  if (!name || String(name).trim().length < 2) {
    res.status(400).json({ error: 'A name is required' });
    return;
  }
  if (!phone || String(phone).trim().length < 5) {
    res.status(400).json({ error: 'A phone number is required' });
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'At least one item is required' });
    return;
  }
  if (items.length > 40) {
    res.status(400).json({ error: 'Too many items in one order' });
    return;
  }

  // Rebuilt rather than forwarded, so that whatever else the caller sent —
  // a price, a tenant id, anything — cannot reach the database at all.
  const lines: Array<{ item_id: string; quantity: number }> = [];
  for (const raw of items) {
    const id = String(raw?.item_id ?? '');
    const qty = Number(raw?.quantity ?? 0);
    if (!UUID_RE.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      res.status(400).json({ error: 'Each item needs a valid id and a quantity between 1 and 99' });
      return;
    }
    lines.push({ item_id: id, quantity: qty });
  }

  try {
    const [row] = await prisma.$queryRaw<Array<{ place_public_order: string }>>`
      SELECT app.place_public_order(
        ${slug},
        ${String(name).trim()},
        ${String(phone).trim()},
        ${JSON.stringify(lines)}::jsonb,
        ${note ? String(note).slice(0, 300) : null}
      ) AS place_public_order`;

    // The token is the customer's only handle on their order, and the only
    // thing this endpoint gives back.
    res.status(201).json({ tracking_token: row.place_public_order });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';

    if (message.includes('not taking orders')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (message.includes('not on the menu')) {
      res.status(400).json({ error: 'One of those items is not on the menu', code: 'unknown_item' });
      return;
    }
    if (message.includes('needs a name') || message.includes('at least one item') || message.includes('too many')) {
      res.status(400).json({ error: 'That order is not valid' });
      return;
    }

    // eslint-disable-next-line no-console
    console.error('[public.order] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /public/track/:token — a status word, and nothing else. */
router.get('/track/:token', readLimit, async (req: Request, res: Response) => {
  const token = String(req.params.token);
  if (!UUID_RE.test(token)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    const rows = await prisma.$queryRaw<
      Array<{ status: string; quoted_total: unknown; placed_at: Date }>
    >`SELECT * FROM app.public_order_status(${token}::uuid)`;

    if (rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).json({
      status: rows[0].status,
      total: Number(rows[0].quoted_total),
      placed_at: rows[0].placed_at,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[public.track] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
