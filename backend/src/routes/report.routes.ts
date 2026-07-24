import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { FINANCE_ROLES, requireRole } from '../middleware/requireRole';
import { getProfitability, getVoids, getWaste } from '../controllers/report.controller';

// Financial reporting. authMiddleware applies to the whole router, so every
// handler runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// requireRole is the ONLY boundary here. Unlike the write paths, the 0010
// policies deliberately leave SELECT ungated, so the database will happily show
// order_items to any member of the organization — a cashier reaching this
// endpoint would see the restaurant's margins. Do not mount it unguarded.
router.get('/profitability', requireRole(...FINANCE_ROLES), getProfitability);

// Voids by cause (0022). Same gate and the same reason: it reports lost revenue
// and the cost of food written off, and it names who authorised each void.
router.get('/voids', requireRole(...FINANCE_ROLES), getVoids);

// What the bin costs (0023): waste by cause, by ingredient and by supplier, as
// a share of total food cost. Money, so the same gate.
router.get('/waste', requireRole(...FINANCE_ROLES), getWaste);

export default router;
