import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { globalSearch } from '../controllers/search.controller';

/**
 * The search box.
 *
 * No role gate. Search is navigation, and RLS already decides what there is to
 * navigate to — gating it by role would only hide things the same user can
 * open by clicking through the sidebar. What keeps it honest is what the
 * handler does NOT return: no totals, no costs, nothing the finance pages are
 * gated for.
 */
const router = Router();

router.use(authMiddleware);
router.get('/', globalSearch);

export default router;
