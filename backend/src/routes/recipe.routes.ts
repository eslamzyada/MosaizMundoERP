import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import { addRecipeLine, getRecipes } from '../controllers/recipe.controller';

// Recipe (Bill of Materials) routes. authMiddleware is applied to the whole
// router, so every handler runs inside an authenticated, RLS-bound transaction
// and must use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

router.get('/', getRecipes);
// A recipe drives food cost — editing it is administrative (enforced by 0010).
router.post('/:id/lines', requireRole(...ADMIN_ROLES), addRecipeLine);

export default router;
