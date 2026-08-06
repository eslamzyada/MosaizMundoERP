import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  createPrinter,
  deletePrinter,
  listPrinters,
  updatePrinter,
} from '../controllers/printer.controller';
import { requireModule } from '../middleware/requireModule';

// Printer routes. authMiddleware applies to the whole router, so every handler
// runs inside an authenticated, RLS-bound transaction and must use req.tx.
const router = Router();

router.use(authMiddleware);

// 0037: the database refuses these writes when the module is off. This turns
// that refusal into an answer that names the module and says where to switch
// it back on — the policy stays the thing that actually enforces it.
router.use(requireModule('printers'));

// Reading is open to every member: a cashier who cannot read the address cannot
// print, and printing is the whole point.
router.get('/', listPrinters);

// Writing is administrative. Where a restaurant's orders physically come out is
// not a decision for whoever is standing at the till — and the 0031 RESTRICTIVE
// policies enforce that in the database regardless of this line.
router.post('/', requireRole(...ADMIN_ROLES), createPrinter);
router.patch('/:id', requireRole(...ADMIN_ROLES), updatePrinter);
router.delete('/:id', requireRole(...ADMIN_ROLES), deletePrinter);

export default router;
