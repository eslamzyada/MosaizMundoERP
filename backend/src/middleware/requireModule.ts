import { NextFunction, Request, Response } from 'express';
import { enabledModules } from '../lib/modules';
import { resolveMembership } from './requireRole';

/**
 * Refuses a request whose capability the tenant does not run (0037).
 *
 * This is NOT the enforcement point for anything with a table behind it — the
 * RESTRICTIVE policies in 0037 are, and they hold whether or not this
 * middleware was ever mounted. What this does is answer legibly: a policy
 * refusal surfaces as an opaque privilege error, and a manager who sees
 * "internal server error" goes looking for an outage instead of a setting.
 *
 * For the two capabilities marked `enforced_in = 'application'` in the
 * catalogue — reporting and exports — this IS the only gate, because they have
 * no writes to refuse. Said plainly rather than hidden: bypassing it would show
 * a tenant its OWN data, which RLS already scopes to them. It is a billing
 * boundary, not a security one, and the catalogue records which is which.
 */
export function requireModule(moduleKey: string) {
  return async function requireModuleMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.tx || !req.userId) {
      res.status(500).json({ error: 'No authenticated transaction on request' });
      return;
    }

    try {
      const membership = await resolveMembership(req);
      if (!membership) {
        res.status(404).json({ error: 'No active organization membership found for this user' });
        return;
      }

      const enabled = await enabledModules(req.tx, membership.organization_id);
      if (!enabled.includes(moduleKey)) {
        res.status(409).json({
          error: 'This part of the system is switched off for your restaurant',
          code: 'module_disabled',
          module: moduleKey,
          // Where to turn it back on, so the answer is actionable rather than
          // merely correct.
          enable_at: '/settings',
        });
        return;
      }

      next();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[requireModule] failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
