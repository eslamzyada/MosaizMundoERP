import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, SALES_ROLES, requireRole } from '../middleware/requireRole';
import { getMenu, getOrders, processCheckout, voidOrder } from '../controllers/pos.controller';
import {
  addOrderItems,
  fireOrder,
  listOpenOrders,
  openOrder,
  removeOrderItem,
  settleOrder,
} from '../controllers/openOrder.controller';

// POS & Checkout routes. authMiddleware is applied to the whole router, so
// every endpoint here runs inside an authenticated, RLS-bound transaction and
// its handlers must use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

router.get('/menu', getMenu);
router.get('/orders', getOrders);
// Ringing up a sale is for sellers, not the read-only accountant. Cashiers and
// staff keep full access here — this is their core job (enforced by 0010).
router.post('/checkout', requireRole(...SALES_ROLES), processCheckout);

// Voiding is a correction, not a sale: the cashier who made the mistake asks a
// manager, who answers the one question that matters — was the food made? The
// database's 0010 orders UPDATE policy is the real boundary (0018).
router.post('/orders/:id/void', requireRole(...ADMIN_ROLES), voidOrder);

// Open tabs (0029). Serving a table is the same act as ringing one up, so these
// carry the same role gate as checkout. The SECURITY DEFINER procedures behind
// them re-check the role themselves — RLS cannot, since the definer bypasses it
// — so requireRole here is the outer of two gates, not the only one.
//
// ORDER MATTERS BELOW. Express matches in declaration order, so '/orders/open'
// and '/orders/items/:itemId' are declared before anything of the shape
// '/orders/:id/...'; reversed, ':id' would swallow the literal 'open' and 'items'
// segments and the handler would be given "open" where it expected a uuid.
router.get('/orders/open', listOpenOrders);
router.post('/orders/open', requireRole(...SALES_ROLES), openOrder);
router.delete('/orders/items/:itemId', requireRole(...SALES_ROLES), removeOrderItem);
router.post('/orders/:id/items', requireRole(...SALES_ROLES), addOrderItems);
router.post('/orders/:id/fire', requireRole(...SALES_ROLES), fireOrder);
router.post('/orders/:id/settle', requireRole(...SALES_ROLES), settleOrder);

export default router;
