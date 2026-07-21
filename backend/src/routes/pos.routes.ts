import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, SALES_ROLES, requireRole } from '../middleware/requireRole';
import { getMenu, getOrders, processCheckout, voidOrder } from '../controllers/pos.controller';

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

export default router;
