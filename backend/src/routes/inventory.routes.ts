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
import {
  cancelStocktake,
  createStocktake,
  getStocktake,
  listStocktakes,
  updateStocktakeCounts,
} from '../controllers/stocktake.controller';
import {
  createWriteOff,
  getExpiringStock,
  listWriteOffs,
} from '../controllers/writeOff.controller';

// Inventory & Warehouse routes. authMiddleware is applied to the whole router,
// so every handler runs inside an authenticated, RLS-bound transaction and must
// use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

// Reads stay open to every member — an accountant must see stock and deficits,
// and reviewing a past count is a read like any other.
router.get('/deficits', getDeficits);
router.get('/items', getRawItems);
router.get('/stock', getStock);
router.get('/stocktakes', listStocktakes);
router.get('/stocktakes/:id', getStocktake);
// What has been discarded, and what is about to turn. Both are reads: an
// accountant needs the loss figures, and a cook needs to know what to use first.
router.get('/write-offs', listWriteOffs);
router.get('/expiring', getExpiringStock);

// Writes are administrative. The database enforces this regardless (0010);
// requireRole just turns the rejection into an honest 403.
router.post('/items', requireRole(...ADMIN_ROLES), createRawItem);
router.patch('/items/:id', requireRole(...ADMIN_ROLES), updateRawItem);
router.post('/receive', requireRole(...ADMIN_ROLES), receiveStock);

// Discarding stock destroys recorded value, so it is gated like voiding. The
// RESTRICTIVE insert policy in 0023 is the real boundary; this is the honest 403
// in front of it.
router.post('/write-offs', requireRole(...ADMIN_ROLES), createWriteOff);

// Counting the shelf: open a draft, record what is there, then post it so the
// books match (0019) — or cancel it if the count was abandoned.
router.post('/stocktakes', requireRole(...ADMIN_ROLES), createStocktake);
router.patch('/stocktakes/:id/items', requireRole(...ADMIN_ROLES), updateStocktakeCounts);
router.post('/stocktakes/:id/post', requireRole(...ADMIN_ROLES), postStocktake);
router.post('/stocktakes/:id/cancel', requireRole(...ADMIN_ROLES), cancelStocktake);

export default router;
