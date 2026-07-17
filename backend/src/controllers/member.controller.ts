import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ROLES = [
  'owner',
  'regional_manager',
  'branch_manager',
  'accountant',
  'cashier',
  'staff',
];

function postgresError(err: unknown): { code?: string; message?: string } {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown; message?: unknown } | undefined;
    return {
      code: typeof meta?.code === 'string' ? meta.code : undefined,
      message: typeof meta?.message === 'string' ? meta.message : undefined,
    };
  }
  return {};
}

/**
 * Every guard rail lives in the 0011 procedures (owner-only, no self-service,
 * never strand the last owner). They raise with a specific SQLSTATE, so the
 * mapping here is thin on purpose — and the database stays the single place
 * those rules are written down.
 *   42501 insufficient_privilege -> 403
 *   P0001 raise_exception        -> 400, surfacing the procedure's own message
 *                                   ("cannot demote the last owner…"), which is
 *                                   already written for a human.
 */
function sendProcedureError(res: Response, err: unknown, context: string): void {
  const { code, message } = postgresError(err);

  if (code === '42501') {
    res.status(403).json({ error: message ?? 'Your role is not permitted to perform this action' });
    return;
  }
  if (code === 'P0001') {
    res.status(400).json({ error: message ?? 'The request was rejected' });
    return;
  }
  if (code === '23505') {
    res.status(409).json({ error: 'An open invitation for that email already exists' });
    return;
  }
  if (code === '23514') {
    res.status(400).json({ error: 'That role is not valid' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[${context}] failed:`, err);
  res.status(500).json({ error: 'Internal server error' });
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

/**
 * GET /api/members
 *
 * The team roster for the caller's organization. Readable by every member (RLS
 * scopes it) — knowing who your colleagues are is not privileged; changing them
 * is.
 */
export async function listMembers(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  try {
    const members = await req.tx.organization_memberships.findMany({
      include: { users: { select: { id: true, email: true } } },
      orderBy: [{ is_active: 'desc' }, { created_at: 'asc' }],
    });

    res.status(200).json(
      members.map((m) => ({
        user_id: m.user_id,
        organization_id: m.organization_id,
        email: m.users.email,
        role: m.role,
        is_active: m.is_active,
        created_at: m.created_at,
        // Lets the client grey out actions the procedures would refuse anyway.
        is_self: m.user_id === req.userId,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[members.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/members/invitations — pending (unaccepted, unexpired) invitations. */
export async function listInvitations(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  try {
    const invitations = await req.tx.organization_invitations.findMany({
      where: { accepted_at: null, expires_at: { gt: new Date() } },
      orderBy: { created_at: 'desc' },
      select: { id: true, email: true, role: true, created_at: true, expires_at: true },
    });
    res.status(200).json(invitations);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[members.invitations] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/members/invite  { email, role }
 *
 * Records an invitation. The invitee joins on signup (the webhook calls
 * app.accept_invitation first), which is what stops them being provisioned
 * their own org instead.
 */
export async function inviteMember(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as { email?: unknown; role?: unknown };

  if (typeof body.email !== 'string' || !body.email.includes('@')) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  if (typeof body.role !== 'string' || !VALID_ROLES.includes(body.role)) {
    res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    await req.tx.$executeRaw`CALL app.invite_org_member(${orgId}::uuid, ${body.email}, ${body.role})`;
    res.status(201).json({ status: 'ok', email: body.email.toLowerCase().trim(), role: body.role });
  } catch (err) {
    sendProcedureError(res, err, 'members.invite');
  }
}

/** PATCH /api/members/:userId/role  { role } */
export async function setMemberRole(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const userId = req.params.userId;
  const body = (req.body ?? {}) as { role?: unknown };

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    res.status(400).json({ error: 'A valid member id (uuid) is required' });
    return;
  }
  if (typeof body.role !== 'string' || !VALID_ROLES.includes(body.role)) {
    res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    await req.tx.$executeRaw`CALL app.set_member_role(${orgId}::uuid, ${userId}::uuid, ${body.role})`;
    res.status(200).json({ status: 'ok', user_id: userId, role: body.role });
  } catch (err) {
    sendProcedureError(res, err, 'members.setRole');
  }
}

/** PATCH /api/members/:userId/active  { is_active } */
export async function setMemberActive(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const userId = req.params.userId;
  const body = (req.body ?? {}) as { is_active?: unknown };

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    res.status(400).json({ error: 'A valid member id (uuid) is required' });
    return;
  }
  if (typeof body.is_active !== 'boolean') {
    res.status(400).json({ error: 'is_active (boolean) is required' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    await req.tx.$executeRaw`CALL app.set_member_active(${orgId}::uuid, ${userId}::uuid, ${body.is_active})`;
    res.status(200).json({ status: 'ok', user_id: userId, is_active: body.is_active });
  } catch (err) {
    sendProcedureError(res, err, 'members.setActive');
  }
}
