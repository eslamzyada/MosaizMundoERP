import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  createSupplier,
  getPriceHistory,
  listSuppliers,
  updateSupplier,
} from '../controllers/supplier.controller';

// Supplier routes. authMiddleware applies to the whole router, so every handler
// runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// Reads are open to every member: an accountant reviewing what was paid needs
// to see who it was paid to, and what prices have been doing.
router.get('/', listSuppliers);
router.get('/price-history', getPriceHistory);

// Buying is administrative. The 0020 RESTRICTIVE policies enforce this in the
// database regardless; requireRole turns the refusal into an honest 403.
// There is deliberately no DELETE route — retiring a supplier is
// PATCH { is_active: false }, so historical lots keep their attribution.
router.post('/', requireRole(...ADMIN_ROLES), createSupplier);
router.patch('/:id', requireRole(...ADMIN_ROLES), updateSupplier);

export default router;
