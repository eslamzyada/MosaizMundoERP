import { Request, Response } from 'express';
import { enabledModules } from '../lib/modules';

/**
 * GET /api/me
 *
 * Resolves the authenticated user's organization AND their role in it. Runs on
 * req.tx (RLS-bound), and additionally filters memberships by the JWT-derived
 * user id, so it returns the org the caller actually belongs to. A user with
 * multiple memberships gets their earliest one (deterministic).
 *
 * Only ACTIVE memberships count: every RLS predicate requires `is_active`, so
 * resolving a deactivated membership here would hand the client an org whose
 * rows the database then refuses to show it.
 *
 * The role drives the client's affordances (an accountant should not be shown a
 * "receive stock" button). It is NOT the enforcement point — that is the
 * RESTRICTIVE policies from 0010, plus requireRole on the write routes.
 */
export async function getMe(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  try {
    const membership = await req.tx.organization_memberships.findFirst({
      where: { user_id: req.userId, is_active: true },
      orderBy: { created_at: 'asc' },
      select: { organization_id: true, role: true },
    });

    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    // The modules ride along with the identity because the client needs both
    // to build one sidebar: what this ROLE is offered, intersected with what
    // this RESTAURANT runs. Two requests would mean a first paint that is
    // wrong in one of the two ways.
    const modules = await enabledModules(req.tx, membership.organization_id);

    res.status(200).json({
      user_id: req.userId,
      organization_id: membership.organization_id,
      role: membership.role,
      modules,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[me] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
