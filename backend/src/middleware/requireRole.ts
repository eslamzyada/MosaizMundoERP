import { NextFunction, Request, Response } from 'express';

/**
 * Route-level role gate. Runs AFTER authMiddleware, so req.tx / req.userId are
 * bound and the lookup is inside the same RLS transaction as the handler.
 *
 * This is NOT the security boundary — migration 0010's RESTRICTIVE policies are.
 * The database rejects an unauthorized write even if this middleware is missing,
 * mis-wired, or bypassed. What this adds is an honest, actionable answer: a
 * clean 403 naming the roles required, instead of a write that reaches Postgres
 * and dies as an opaque row-level-security error mapped to a generic 400/500.
 *
 * Role is resolved from the caller's earliest ACTIVE membership — the same rule
 * GET /api/me uses, so the client's view of "my role" and the gate agree.
 */
export function requireRole(...allowedRoles: string[]) {
  return async function roleGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.tx || !req.userId) {
      res.status(500).json({ error: 'No authenticated transaction on request' });
      return;
    }

    try {
      const membership = await req.tx.organization_memberships.findFirst({
        where: { user_id: req.userId, is_active: true },
        orderBy: { created_at: 'asc' },
        select: { role: true },
      });

      if (!membership) {
        res.status(403).json({ error: 'No active organization membership' });
        return;
      }

      if (!allowedRoles.includes(membership.role)) {
        res.status(403).json({
          error: 'Your role is not permitted to perform this action',
          role: membership.role,
          required: allowedRoles,
        });
        return;
      }

      next();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[requireRole] failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/** Operational writes: receiving stock, stocktakes, catalog and recipe edits. */
export const ADMIN_ROLES = ['owner', 'regional_manager', 'branch_manager'];

/** May ring up a sale. Everyone except accountant, who is read-only. */
export const SALES_ROLES = [...ADMIN_ROLES, 'cashier', 'staff'];

/**
 * May see money: revenue, cost of goods sold, margin.
 *
 * The accountant is read-only for operations but is precisely who reads the
 * books, so they are included here even though they are absent from
 * ADMIN_ROLES. Cashiers and staff are not: ringing up a sale does not imply
 * seeing what the restaurant makes on it.
 *
 * Unlike the write paths, the database is NOT a second line of defence here —
 * SELECT is deliberately ungated by the 0010 policies, so any member could read
 * order_items directly. This middleware is the boundary for financial
 * reporting, which is why the endpoint must not be mounted without it.
 */
export const FINANCE_ROLES = [...ADMIN_ROLES, 'accountant'];
