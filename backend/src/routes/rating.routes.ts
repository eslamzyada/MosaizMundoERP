import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import { listRatings, upsertRating } from '../controllers/rating.controller';

// Employee ratings (0027). authMiddleware applies to the whole router, so every
// handler runs inside an authenticated, RLS-bound transaction.
const router = Router();

router.use(authMiddleware);

// Unlike every other read in this API, this one is GATED — and twice over. The
// 0027 RESTRICTIVE policy covers SELECT, so a cashier would see an empty list
// even without requireRole; the role check is here so they get an honest 403
// instead of a blank page that looks like "no ratings exist".
router.get('/', requireRole(...ADMIN_ROLES), listRatings);

// PUT, not POST: there is one rating per person per month, so re-submitting is
// a revision rather than a second opinion.
router.put('/', requireRole(...ADMIN_ROLES), upsertRating);

export default router;
