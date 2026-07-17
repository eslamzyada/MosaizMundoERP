import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getDeficits,
  getRawItems,
  getStock,
  postStocktake,
  receiveStock,
} from '../controllers/inventory.controller';

// Inventory & Warehouse routes. authMiddleware is applied to the whole router,
// so every handler runs inside an authenticated, RLS-bound transaction and must
// use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

router.get('/deficits', getDeficits);
router.get('/items', getRawItems);
router.get('/stock', getStock);
router.post('/receive', receiveStock);
router.post('/stocktakes/:id/post', postStocktake);

export default router;
