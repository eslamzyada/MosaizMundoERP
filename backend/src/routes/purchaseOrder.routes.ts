import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  getReorderSuggestions,
  listPurchaseOrders,
  placePurchaseOrder,
  receivePurchaseOrder,
} from '../controllers/purchaseOrder.controller';
import { requireModule } from '../middleware/requireModule';

// Purchase order routes. authMiddleware applies to the whole router, so every
// handler runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// 0037: the database refuses these writes when the module is off. This turns
// that refusal into an answer that names the module and says where to switch
// it back on — the policy stays the thing that actually enforces it.
router.use(requireModule('purchasing'));

// Reads stay open: an accountant checking what the business is committed to
// needs to see outstanding orders.
router.get('/', listPurchaseOrders);
// Declared BEFORE '/:id': otherwise "suggestions" is read as an order id and
// answered with a 400 for a malformed uuid.
router.get('/suggestions', getReorderSuggestions);
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
