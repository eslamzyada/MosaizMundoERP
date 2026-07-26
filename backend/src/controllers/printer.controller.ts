import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Printers — where a ticket physically comes out (0031).
 *
 * The API gateway never talks to a printer. It cannot: the printer sits on the
 * restaurant's LAN and the backend may be behind a tunnel on another continent.
 * All this does is hold the address, and the till on the same network opens the
 * socket. That division is why `host` is untouched here beyond trimming — it is
 * meaningful only on the network the till is standing on.
 *
 * The 0031 RESTRICTIVE policies are the real boundary; requireRole on the route
 * turns a refusal into an honest 403 instead of a silent zero-row update.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a printer can be FOR. Mirrors the CHECK in 0031. */
export const PRINTER_ROLES = ['kitchen', 'receipt'] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];

function isPrinterRole(value: unknown): value is PrinterRole {
  return typeof value === 'string' && (PRINTER_ROLES as readonly string[]).includes(value);
}

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
  }
  return undefined;
}

/** The caller's organization: earliest ACTIVE membership — as GET /api/me does. */
async function resolveOrgId(req: Request): Promise<string | null> {
  const membership = await req.tx!.organization_memberships.findFirst({
    where: { user_id: req.userId!, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Turns a database refusal into an HTTP answer.
 *
 * P2002 / 23505 is the interesting one: it means an ACTIVE printer already
 * holds this role. That is a 409, and the message has to say what to do about
 * it, because "duplicate key" tells a manager nothing — a printer is replaced
 * by deactivating the old one, not by adding a second.
 */
function respond(err: unknown, res: Response, context: string): void {
  const code = postgresErrorCode(err);

  if (code === 'P2002' || code === '23505') {
    res.status(409).json({
      error:
        'This organization already has an active printer for that role. ' +
        'Deactivate the current one first — two active printers would mean ' +
        'tickets going to whichever the till happened to read.',
      code: 'duplicate_active_role',
    });
    return;
  }
  if (code === '42501') {
    res.status(403).json({ error: 'Configuring printers is limited to managers' });
    return;
  }
  if (code === 'P2025') {
    res.status(404).json({ error: 'Printer not found' });
    return;
  }
  if (code === '23514') {
    res.status(400).json({ error: 'The printer details were rejected by the database' });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`[${context}] failed:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * GET /api/printers
 *
 * Open to every member, because a cashier who cannot read the address cannot
 * print. Inactive printers are included: the settings page shows what was
 * replaced, and hiding them would make a swapped printer look like it vanished.
 */
export async function listPrinters(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    // No organization filter: req.tx is RLS-bound, and adding one would imply
    // the isolation lives in this query rather than in the policy.
    const printers = await req.tx.printers.findMany({
      orderBy: [{ is_active: 'desc' }, { role: 'asc' }, { created_at: 'desc' }],
    });
    res.status(200).json(printers);
  } catch (err) {
    respond(err, res, 'printers.list');
  }
}

/**
 * POST /api/printers
 *   { name, role: 'kitchen'|'receipt', host, port?, is_active? }
 *
 * port defaults to 9100 in the database — the raw-printing port practically
 * every network thermal printer listens on — so it is not required here.
 */
export async function createPrinter(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = text(body.name);
  const host = text(body.host);
  const role = body.role;

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!isPrinterRole(role)) {
    res.status(400).json({ error: 'role must be one of: ' + PRINTER_ROLES.join(', ') });
    return;
  }
  if (!host) {
    res.status(400).json({ error: 'host is required (the printer\'s IP or hostname)' });
    return;
  }

  const port = body.port === undefined ? 9100 : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: 'port must be a whole number between 1 and 65535' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(403).json({ error: 'No active organization membership' });
      return;
    }

    const printer = await req.tx.printers.create({
      data: {
        organization_id: orgId,
        name,
        role,
        host,
        port,
        is_active: body.is_active === undefined ? true : Boolean(body.is_active),
      },
    });
    res.status(201).json(printer);
  } catch (err) {
    respond(err, res, 'printers.create');
  }
}

/**
 * PATCH /api/printers/:id
 *   { name?, host?, port?, is_active? }
 *
 * role is deliberately NOT editable. A printer's role is what a ticket is
 * routed by, and flipping it in place would silently redirect every kitchen
 * ticket to the till by the counter. Retiring one and adding another makes that
 * change visible, and the partial unique index enforces the ordering.
 */
export async function updatePrinter(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid printer id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Prisma.printersUpdateInput = {};

  if (body.name !== undefined) {
    const name = text(body.name);
    if (!name) {
      res.status(400).json({ error: 'name cannot be blank' });
      return;
    }
    data.name = name;
  }
  if (body.host !== undefined) {
    const host = text(body.host);
    if (!host) {
      res.status(400).json({ error: 'host cannot be blank' });
      return;
    }
    data.host = host;
  }
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'port must be a whole number between 1 and 65535' });
      return;
    }
    data.port = port;
  }
  if (body.is_active !== undefined) {
    data.is_active = Boolean(body.is_active);
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  try {
    const printer = await req.tx.printers.update({ where: { id }, data });
    res.status(200).json(printer);
  } catch (err) {
    // A row RLS filtered is indistinguishable from one that does not exist, and
    // Prisma reports both as P2025. requireRole has already turned the role
    // case into a 403, so 404 here is the honest remaining answer.
    respond(err, res, 'printers.update');
  }
}

/**
 * DELETE /api/printers/:id
 *
 * A genuine delete, unlike suppliers. Nothing references a printer — no history
 * hangs off it — so a mistyped address is best simply removed. Retiring one
 * that has been used is still PATCH { is_active: false }; both are offered
 * because they mean different things.
 */
export async function deletePrinter(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid printer id (uuid) is required' });
    return;
  }

  try {
    await req.tx.printers.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    respond(err, res, 'printers.delete');
  }
}
