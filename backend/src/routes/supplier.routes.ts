import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  createSupplier,
  getPriceHistory,
  listSuppliers,
  updateSupplier,
} from '../controllers/supplier.controller';
import { requireModule } from '../middleware/requireModule';

// Supplier routes. authMiddleware applies to the whole router, so every handler
// runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// 0037: the database refuses these writes when the module is off. This turns
// that refusal into an answer that names the module and says where to switch
// it back on — the policy stays the thing that actually enforces it.
router.use(requireModule('purchasing'));

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
