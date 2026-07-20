import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  addRecipeLine,
  deleteRecipeLine,
  getRecipes,
  updateRecipeLine,
} from '../controllers/recipe.controller';

// Recipe (Bill of Materials) routes. authMiddleware is applied to the whole
// router, so every handler runs inside an authenticated, RLS-bound transaction
// and must use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

router.get('/', getRecipes);

// A recipe drives food cost — editing it is administrative (enforced by the
// 0010 insert/update policies and, for removal, require_admin_delete in 0014).
// A line is addressed by its own id rather than nested under the sellable item:
// the id is unique and already RLS-scoped, so no ownership check is duplicated
// in the handler.
router.post('/:id/lines', requireRole(...ADMIN_ROLES), addRecipeLine);
router.patch('/lines/:lineId', requireRole(...ADMIN_ROLES), updateRecipeLine);
router.delete('/lines/:lineId', requireRole(...ADMIN_ROLES), deleteRecipeLine);

export default router;
