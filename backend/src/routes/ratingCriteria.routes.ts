import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  createCriterion,
  deleteCriterion,
  listCriteria,
  listCriterionScores,
  updateCriterion,
  upsertCriterionScore,
} from '../controllers/ratingCriteria.controller';
import { requireModule } from '../middleware/requireModule';

/**
 * The review rubric (0033).
 *
 * The gates are not uniform here, and that is the point:
 *
 *   the CRITERIA are read by everyone. A standard nobody may read is a standard
 *   nobody can meet, and the 0033 policies leave SELECT open on purpose.
 *
 *   the SCORES are read only by administrators, following 0027's decision for
 *   the overall rating rather than inventing a second, softer rule for the same
 *   kind of information.
 */
const router = Router();

router.use(authMiddleware);

// 0037: the database refuses these writes when the module is off. This turns
// that refusal into an answer that names the module and says where to switch
// it back on — the policy stays the thing that actually enforces it.
router.use(requireModule('performance'));

// /scores is declared BEFORE /:id, or Express matches "scores" as an id and
// every request for the scores becomes a lookup for a criterion called scores.
router.get('/scores', requireRole(...ADMIN_ROLES), listCriterionScores);
router.put('/scores', requireRole(...ADMIN_ROLES), upsertCriterionScore);

router.get('/', listCriteria);
router.post('/', requireRole(...ADMIN_ROLES), createCriterion);
router.patch('/:id', requireRole(...ADMIN_ROLES), updateCriterion);
router.delete('/:id', requireRole(...ADMIN_ROLES), deleteCriterion);

export default router;
