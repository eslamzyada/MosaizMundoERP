import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { readModules, readPlan } from '../lib/modules';
import { resolveMembership } from '../middleware/requireRole';
import { postgresErrorCode } from '../lib/postgresError';

/**
 * Which parts of the system this restaurant runs (0037).
 *
 * Reading is open to every member: a waiter who cannot find الجرد should be
 * able to learn that their restaurant does not do stocktakes, rather than
 * conclude the app is broken. Writing goes through app.set_module, which
 * enforces the owner check, the dependency rules and the audit trail — this
 * controller does not re-implement any of them, it translates their refusals.
 */

export async function listModules(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const rows = await readModules(req.tx, membership.organization_id);
    res.status(200).json(
      rows.map((r) => ({
        key: r.key,
        name: r.name_ar,
        description: r.description_ar,
        depends_on: r.depends_on,
        enforced_in: r.enforced_in,
        enabled: r.enabled,
        // 0044. The screen has to say WHY something is off, and "not in your
        // plan" and "your owner switched it off" are different sentences with
        // different next steps — one of them is a conversation with sales.
        min_plan: r.min_plan,
        entitled: r.entitled,
        grandfathered: r.grandfathered,
      })),
    );
  } catch (err) {
    logger.error('modules.list failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PUT /api/modules/:key  { enabled: boolean }
 *
 * Every refusal below is the database's, mapped to the answer that tells the
 * caller what to do about it. A dependency conflict is a 409 and NOT a 403:
 * the caller is allowed, the request is simply out of order.
 */
export async function setModule(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    // The dependency rules live in app.set_module and it will refuse on its
    // own. This pre-check exists only to say WHICH module is in the way:
    // scraping that name out of a wrapped Prisma error string was the
    // alternative, and a test caught it returning nothing useful. If the two
    // ever disagree, the procedure below still refuses — this can only produce
    // a better sentence, never a different outcome.
    const catalogue = await readModules(req.tx, membership.organization_id);
    const target = catalogue.find((m) => m.key === req.params.key);
    if (!target) {
      res.status(404).json({ error: 'No such module' });
      return;
    }

    const conflict = enabled
      ? target.depends_on.find((d) => !catalogue.find((m) => m.key === d)?.enabled)
      : catalogue.find((m) => m.enabled && m.depends_on.includes(target.key))?.key;

    if (conflict) {
      res.status(409).json({
        error: enabled
          ? `${target.name_ar} needs ${conflict} switched on first`
          : `${conflict} is still switched on, and it depends on ${target.name_ar}`,
        code: 'module_dependency',
        module: target.key,
        blocked_by: conflict,
      });
      return;
    }

    // The ceiling (0044). Like the dependency check above, this exists to say
    // WHICH plan rather than to enforce — app.set_module refuses on its own.
    //
    // Only on the way ON. Switching something off is always allowed, at every
    // tier: a tenant that has stopped paying for الجرد should still be able to
    // clear it off their screen.
    if (enabled && !target.entitled && !target.grandfathered) {
      res.status(402).json({
        error: `${target.name_ar} is not included in your plan`,
        code: 'plan_required',
        module: target.key,
        required_plan: target.min_plan,
        current_plan: await readPlan(req.tx, membership.organization_id),
      });
      return;
    }

    await req.tx.$queryRaw`
      SELECT app.set_module(${membership.organization_id}::uuid, ${req.params.key}, ${enabled})`;

    res.status(200).json({ key: req.params.key, enabled });
  } catch (err) {
    const code = postgresErrorCode(err);
    const message = err instanceof Error ? err.message : '';

    // 0044's own code, kept as a backstop for the race the pre-check below
    // cannot close: a downgrade landing between reading the catalogue and
    // calling the procedure. Asked BEFORE 42501 because they are different
    // instructions and only one is actionable by the person reading it — a 403
    // sends an owner to find someone more senior, when the answer is that
    // nobody in the restaurant can switch this on at this price.
    if (code === 'MZ402') {
      res.status(402).json({
        error: 'Your plan does not include this module',
        code: 'plan_required',
        module: req.params.key,
      });
      return;
    }

    if (code === '42501') {
      res.status(403).json({
        error: 'Only an owner or a regional manager may change which modules run',
      });
      return;
    }
    if (code === '23503') {
      // Reached only when the procedure sees a conflict the pre-check above
      // did not — a concurrent change between the two statements. Rare, and
      // still an honest answer rather than a 500.
      res.status(409).json({
        error: 'That change would leave the system in a shape that cannot work',
        code: 'module_dependency',
      });
      return;
    }
    if (code === '22023') {
      res.status(404).json({ error: 'No such module' });
      return;
    }

    logger.error('modules.set failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
