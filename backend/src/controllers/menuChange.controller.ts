import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Proposing and deciding a change to the menu (0035).
 *
 * The API is not what makes this strict — the application role has no INSERT or
 * UPDATE on sellable_items at all, so these endpoints are not a gate in front of
 * a door, they are the only door. A bug here fails; it does not leak.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CHANGE_KINDS = ['create', 'update', 'retire'] as const;
type Kind = (typeof CHANGE_KINDS)[number];

const REASON_MIN = 3;
const REASON_MAX = 1000;

/**
 * The SQLSTATE behind a Prisma error, however Prisma chose to wrap it.
 *
 * Three shapes, and only checking the first is how a policy refusal becomes a
 * 500: a typed call that violates a constraint raises a KNOWN error carrying
 * `meta.code`; some raise the Prisma code itself; and a RESTRICTIVE policy
 * refusing an INSERT comes back as an UNKNOWN error whose SQLSTATE exists only
 * inside the message text. Measured, not guessed — the waiter refusal in this
 * suite arrived as the third.
 */
function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
  }
  if (err instanceof Error) {
    const match = err.message.match(/code:\s*"(\w+)"/);
    if (match) return match[1];
  }
  return undefined;
}

async function resolveOrgId(req: Request): Promise<string | null> {
  const membership = await req.tx!.organization_memberships.findFirst({
    where: { user_id: req.userId!, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
}

const asNumber = (v: Prisma.Decimal | number | null) => (v === null ? null : Number(v));

/**
 * GET /api/menu-changes?status=pending
 *
 * Readable by every member. A waiter quoting tonight's price should be able to
 * see that it is about to change — that is why the 0035 policies leave SELECT
 * open while gating every write.
 */
export async function listChanges(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && !['pending', 'approved', 'rejected', 'withdrawn'].includes(status)) {
    res.status(400).json({ error: 'status must be pending, approved, rejected or withdrawn' });
    return;
  }

  try {
    const rows = await req.tx.menu_change_requests.findMany({
      where: status ? { status } : {},
      orderBy: [{ status: 'asc' }, { requested_at: 'desc' }],
      take: 200,
      include: { sellable_items: { select: { name: true, sku: true, price: true } } },
    });

    res.status(200).json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        sellable_item_id: r.sellable_item_id,
        /** What the dish looks like NOW, so the queue can show a real diff. */
        current: r.sellable_items
          ? {
              name: r.sellable_items.name,
              sku: r.sellable_items.sku,
              price: asNumber(r.sellable_items.price),
            }
          : null,
        proposed: {
          name: r.proposed_name,
          sku: r.proposed_sku,
          price: asNumber(r.proposed_price),
        },
        reason: r.reason,
        requested_by: r.requested_by,
        requested_at: r.requested_at,
        decided_by: r.decided_by,
        decided_at: r.decided_at,
        decision_note: r.decision_note,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[menuChange.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/menu-changes  { kind, sellable_item_id?, name?, sku?, price?, reason }
 *
 * Files a proposal. The RESTRICTIVE policy decides whether this caller may
 * propose at all, so a role that may not gets a 403 from the database rather
 * than a check here that could drift from it.
 */
export async function proposeChange(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = body.kind as Kind;

  if (!(CHANGE_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: `kind must be one of: ${CHANGE_KINDS.join(', ')}` });
    return;
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    // Required, not optional: a queue of unexplained changes is a queue nobody
    // reads, and the reason is what the decision is actually made on.
    res.status(400).json({
      error: `reason is required and must be between ${REASON_MIN} and ${REASON_MAX} characters`,
    });
    return;
  }

  const itemId = typeof body.sellable_item_id === 'string' ? body.sellable_item_id : null;
  if (kind !== 'create' && (!itemId || !UUID_RE.test(itemId))) {
    res.status(400).json({ error: 'sellable_item_id (uuid) is required to change an existing dish' });
    return;
  }
  if (kind === 'create' && itemId) {
    res.status(400).json({ error: 'a new dish must not name an existing item' });
    return;
  }

  const name = typeof body.name === 'string' ? body.name.trim() : null;
  const sku = typeof body.sku === 'string' ? body.sku.trim() : null;
  const price = body.price === undefined || body.price === null ? null : Number(body.price);

  if (price !== null && (!Number.isFinite(price) || price < 0)) {
    res.status(400).json({ error: 'price must be a number of at least 0' });
    return;
  }
  if (kind === 'create' && (!name || price === null)) {
    res.status(400).json({ error: 'a new dish needs a name and a price' });
    return;
  }
  if (kind === 'update' && !name && !sku && price === null) {
    res.status(400).json({ error: 'an update must change at least one of: name, sku, price' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(403).json({ error: 'No active organization membership' });
      return;
    }

    const created = await req.tx.menu_change_requests.create({
      data: {
        organization_id: orgId,
        kind,
        sellable_item_id: itemId,
        proposed_name: name,
        proposed_sku: sku,
        proposed_price: price,
        reason,
        // Never from the body: the policy compares this against the session
        // identity, so a forged one is refused rather than believed.
        requested_by: req.userId,
      },
    });

    res.status(201).json({ id: created.id, status: created.status, kind: created.kind });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '42501') {
      res.status(403).json({
        error: 'Proposing a menu change is limited to the kitchen and managers',
      });
      return;
    }
    if (code === 'P2003' || code === '23503') {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    if (code === '23514') {
      res.status(400).json({ error: 'The proposed change was rejected by the database' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[menuChange.propose] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/menu-changes/:id/decide  { approve: boolean, note? }
 *
 * Everything that matters happens inside app.decide_menu_change: the role check,
 * the two-person rule, and applying the change in the same transaction as the
 * decision. This maps its refusals onto answers somebody can act on.
 */
export async function decideChange(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.approve !== 'boolean') {
    res.status(400).json({ error: 'approve must be true or false' });
    return;
  }
  const note = typeof body.note === 'string' ? body.note.trim() || null : null;

  try {
    // $executeRaw, not $queryRaw: the function returns a uuid, and reading the
    // result is not worth a second round trip when the queue is refetched
    // anyway. (A void-returning function through $queryRaw is also the P2010
    // that bit the delete path once already.)
    await req.tx.$executeRaw`SELECT app.decide_menu_change(${req.params.id}::uuid, ${body.approve}, ${note})`;
    res.status(200).json({ id: req.params.id, status: body.approve ? 'approved' : 'rejected' });
  } catch (err) {
    const code = postgresErrorCode(err);
    const message = err instanceof Error ? err.message : '';

    if (code === 'P0002' || message.includes('not found')) {
      res.status(404).json({ error: 'Menu change request not found' });
      return;
    }
    if (code === '42501' || message.includes('other than the person who proposed')) {
      res.status(403).json({
        error: message.includes('other than the person who proposed')
          ? 'A menu change must be decided by somebody other than the person who proposed it'
          : 'Deciding a menu change is limited to the owner or a regional manager',
      });
      return;
    }
    if (code === '55000' || message.includes('already')) {
      res.status(409).json({ error: 'This request has already been decided' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[menuChange.decide] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/menu-changes/:id/withdraw
 *
 * Taking back your own proposal. The 0035 UPDATE policy allows exactly this and
 * nothing else, so somebody else's request matches zero rows and answers 404
 * rather than confirming it exists.
 */
export async function withdrawChange(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  try {
    const result = await req.tx.menu_change_requests.updateMany({
      where: { id: req.params.id, status: 'pending' },
      data: { status: 'withdrawn', decided_at: new Date() },
    });

    if (result.count === 0) {
      res.status(404).json({ error: 'No pending request of yours with that id' });
      return;
    }
    res.status(200).json({ id: req.params.id, status: 'withdrawn' });
  } catch (err) {
    if (postgresErrorCode(err) === '42501') {
      res.status(403).json({ error: 'Only the person who proposed a change may withdraw it' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[menuChange.withdraw] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
