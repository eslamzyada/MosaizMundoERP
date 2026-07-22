import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  placePurchaseOrder,
  receivePurchaseOrder,
} from '../controllers/purchaseOrder.controller';

// Purchase order routes. authMiddleware applies to the whole router, so every
// handler runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// Reads stay open: an accountant checking what the business is committed to
// needs to see outstanding orders.
router.get('/', listPurchaseOrders);
router.get('/:id', getPurchaseOrder);

// Committing money is administrative. The 0021 RESTRICTIVE policies enforce it
// in the database regardless; requireRole turns the refusal into an honest 403.
// There is no DELETE — a cancelled order is kept, because what was ordered and
// then abandoned is part of the purchasing record.
router.post('/', requireRole(...ADMIN_ROLES), createPurchaseOrder);
router.post('/:id/place', requireRole(...ADMIN_ROLES), placePurchaseOrder);
router.post('/:id/receive', requireRole(...ADMIN_ROLES), receivePurchaseOrder);
router.post('/:id/cancel', requireRole(...ADMIN_ROLES), cancelPurchaseOrder);

export default router;
