import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import { createItem, listItems, updateItem } from '../controllers/catalog.controller';

// Catalog (menu item) management. authMiddleware applies to the whole router, so
// every handler runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// Reading the menu is open to any member.
router.get('/items', listItems);

// Creating and pricing items is administrative. The database enforces this via
// the 0010 RESTRICTIVE policies regardless; requireRole turns the refusal into
// an honest 403.
router.post('/items', requireRole(...ADMIN_ROLES), createItem);
router.patch('/items/:id', requireRole(...ADMIN_ROLES), updateItem);

export default router;
