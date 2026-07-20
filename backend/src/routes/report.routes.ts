import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { FINANCE_ROLES, requireRole } from '../middleware/requireRole';
import { getProfitability } from '../controllers/report.controller';

// Financial reporting. authMiddleware applies to the whole router, so every
// handler runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// requireRole is the ONLY boundary here. Unlike the write paths, the 0010
// policies deliberately leave SELECT ungated, so the database will happily show
// order_items to any member of the organization — a cashier reaching this
// endpoint would see the restaurant's margins. Do not mount it unguarded.
router.get('/profitability', requireRole(...FINANCE_ROLES), getProfitability);

export default router;
