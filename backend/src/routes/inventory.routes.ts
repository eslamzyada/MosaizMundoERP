import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDeficits, receiveStock } from '../controllers/inventory.controller';

// Inventory & Warehouse routes. authMiddleware is applied to the whole router,
// so every handler runs inside an authenticated, RLS-bound transaction and must
// use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

router.get('/deficits', getDeficits);
router.post('/receive', receiveStock);

export default router;
