import { logger } from '../lib/logger';
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
/**
 * The caller's role, by the same rule requireRole and GET /api/me use.
 *
 * For handlers that must not REFUSE a request but should shape what it returns
 * — an endpoint whose data is partly operational and partly financial, where
 * gating the whole route would deny people information they legitimately need.
 * Returns null when there is no active membership.
 */
export async function callerRole(req: Request): Promise<string | null> {
  return (await resolveMembership(req))?.role ?? null;
}

/**
 * The caller's membership — organization AND role — by that same single rule.
 *
 * Exported because the module gate (0037) needs the organization id as well as
 * the role, and a second lookup written its own way is a second rule that can
 * disagree with this one about which membership counts.
 */
export async function resolveMembership(
  req: Request,
): Promise<{ organization_id: string; role: string } | null> {
  if (!req.tx || !req.userId) return null;
  const membership = await req.tx.organization_memberships.findFirst({
    where: { user_id: req.userId, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true, role: true },
  });
  return membership ?? null;
}

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
      logger.error('requireRole failed', err, {
        request_id: req.requestId,
        user_id: req.userId,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/** Operational writes: receiving stock, stocktakes, catalog and recipe edits. */
export const ADMIN_ROLES = ['owner', 'regional_manager', 'branch_manager'];

/**
 * May ring up a sale.
 *
 * A waiter opening a tab and adding to it IS a sale in progress, so they sit
 * here beside the cashier. The accountant is read-only, and the kitchen writes
 * nothing at all — it is a reading role by design (0034), not by omission.
 *
 * Mirrors app.user_can_sell. The database is the boundary; this list exists so
 * a refusal arrives as an honest 403 rather than an opaque policy error.
 */
export const SALES_ROLES = [...ADMIN_ROLES, 'cashier', 'waiter', 'staff'];

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
