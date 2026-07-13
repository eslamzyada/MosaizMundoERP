import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { addRecipeLine, getRecipes } from '../controllers/recipe.controller';

// Recipe (Bill of Materials) routes. authMiddleware is applied to the whole
// router, so every handler runs inside an authenticated, RLS-bound transaction
// and must use req.tx for all database access.
const router = Router();

router.use(authMiddleware);

router.get('/', getRecipes);
router.post('/:id/lines', addRecipeLine);

export default router;
