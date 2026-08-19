import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { FINANCE_ROLES, requireRole } from '../middleware/requireRole';
import {
  getEmployeePerformance,
  getInventoryAssets,
  getProfitability,
  getSummary,
  getVoids,
  getWaste,
} from '../controllers/report.controller';
import { getServiceReport } from '../controllers/serviceReport.controller';
import { getTrends } from '../controllers/trends.controller';
import { getPurchasing } from '../controllers/purchasing.controller';
import { requireModule } from '../middleware/requireModule';

// Financial reporting. authMiddleware applies to the whole router, so every
// handler runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// requireRole is the ONLY boundary here. Unlike the write paths, the 0010
// policies deliberately leave SELECT ungated, so the database will happily show
// order_items to any member of the organization — a cashier reaching this
// endpoint would see the restaurant's margins. Do not mount it unguarded.
/**
 * The dashboard's headline figures. Same finance roles as the rest of this
 * router: it reports revenue, and revenue is what those roles are gated for.
 */
router.get('/summary', requireRole(...FINANCE_ROLES), getSummary);

router.get('/profitability', requireRole(...FINANCE_ROLES), getProfitability);

// Voids by cause (0022). Same gate and the same reason: it reports lost revenue
// and the cost of food written off, and it names who authorised each void.
router.get('/voids', requireRole(...FINANCE_ROLES), getVoids);

// What the bin costs (0023): waste by cause, by ingredient and by supplier, as
// a share of total food cost. Money, so the same gate.
router.get('/waste', requireRole(...FINANCE_ROLES), getWaste);

// Inventory read as an asset: where capital is tied up, how long it has sat,
// and what is not moving. Money, so the same gate.
router.get('/inventory-assets', requireRole(...FINANCE_ROLES), getInventoryAssets);

// How each person performed (0026). FINANCE_ROLES rather than a wider gate:
// this reports revenue per head, and one employee's takings are not another
// employee's business.
router.get('/employees', requireRole(...FINANCE_ROLES), getEmployeePerformance);

// Sales, waste and buying on ONE shared timeline, bucketed and gap-filled, so
// the figures can be drawn rather than read. Same gate — it is all money.
// The one feed that only المؤشرات consumes, so it is the one report route the
// insights module can gate without taking a figure away from الأرباح too.
router.get('/trends', requireModule('insights'), requireRole(...FINANCE_ROLES), getTrends);

// What was bought, from whom, and what has been paid for but has not arrived.
// The one side of the business that had no report at all.
router.get('/purchasing', requireRole(...FINANCE_ROLES), getPurchasing);

// What a service cost and what it earned (0038-0043 finally read).
//
// NOT gated by requireModule: the report spans several capabilities and names
// the ones this tenant does not run as absent rather than refusing wholesale.
// A restaurant without reservations still wants to know its labour share.
router.get('/service', requireRole(...FINANCE_ROLES), getServiceReport);

export default router;
