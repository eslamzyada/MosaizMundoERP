import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getMenu, processCheckout } from '../controllers/pos.controller';

// POS & Checkout routes. authMiddleware is applied to the whole router, so
// every endpoint here runs inside an authenticated, RLS-bound transaction and
// its handlers must use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

router.get('/menu', getMenu);
router.post('/checkout', processCheckout);

export default router;
