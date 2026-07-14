import { Request, Response } from 'express';

/**
 * GET /api/me
 *
 * Resolves the authenticated user's organization. Runs on req.tx (RLS-bound),
 * and additionally filters memberships by the JWT-derived user id, so it returns
 * the org the caller actually belongs to. A user with multiple memberships gets
 * their earliest one (deterministic).
 */
export async function getMe(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  try {
    const membership = await req.tx.organization_memberships.findFirst({
      where: { user_id: req.userId },
      orderBy: { created_at: 'asc' },
      select: { organization_id: true },
    });

    if (!membership) {
      res.status(404).json({ error: 'No organization membership found for this user' });
      return;
    }

    res.status(200).json({
      user_id: req.userId,
      organization_id: membership.organization_id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[me] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
