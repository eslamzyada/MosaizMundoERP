import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  createRawItem,
  getDeficits,
  getRawItems,
  getStock,
  postStocktake,
  receiveStock,
  updateRawItem,
} from '../controllers/inventory.controller';

// Inventory & Warehouse routes. authMiddleware is applied to the whole router,
// so every handler runs inside an authenticated, RLS-bound transaction and must
// use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

// Reads stay open to every member — an accountant must see stock and deficits.
router.get('/deficits', getDeficits);
router.get('/items', getRawItems);
router.get('/stock', getStock);

// Writes are administrative. The database enforces this regardless (0010);
// requireRole just turns the rejection into an honest 403.
router.post('/items', requireRole(...ADMIN_ROLES), createRawItem);
router.patch('/items/:id', requireRole(...ADMIN_ROLES), updateRawItem);
router.post('/receive', requireRole(...ADMIN_ROLES), receiveStock);
router.post('/stocktakes/:id/post', requireRole(...ADMIN_ROLES), postStocktake);

export default router;
