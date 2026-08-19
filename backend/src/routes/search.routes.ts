import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { globalSearch } from '../controllers/search.controller';

/**
 * The search box.
 *
 * This file used to argue the opposite, and the argument is worth keeping
 * because it was wrong in an instructive way:
 *
 *     No role gate. Search is navigation, and RLS already decides what there
 *     is to navigate to — gating it by role would only hide things the same
 *     user can open by clicking through the sidebar. What keeps it honest is
 *     what the handler does NOT return: no totals, no costs...
 *
 * RLS decides which TENANT's rows exist, never which of them a waiter should
 * see. And "the same user can open it by clicking through the sidebar" was
 * false: the sidebar was built per role, the ROUTES were not guarded at all,
 * and this endpoint returned records from pages a waiter had no link to —
 * colleagues' emails and roles, suppliers, purchase orders, printers by
 * host:port.
 *
 * Money was never the only thing worth gating. The scope is now the caller's
 * role, resolved on the server; see lib/searchScope.ts.
 */
const router = Router();

router.use(authMiddleware);
router.get('/', globalSearch);

export default router;
