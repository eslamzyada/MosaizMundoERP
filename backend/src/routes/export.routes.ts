import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { FINANCE_ROLES, requireRole } from '../middleware/requireRole';
import { exportReport } from '../controllers/export.controller';
import { requireModule } from '../middleware/requireModule';

/**
 * Reports as files.
 *
 * The same FINANCE_ROLES gate as the reports themselves — a PDF of the margins
 * is still the margins, and a file is easier to forward than a screen.
 */
const router = Router();

router.use(authMiddleware);

// 0037: this one has no writes to gate, so THIS is the gate. Recorded as
// enforced_in = 'application' in the module catalogue rather than implied,
// because a bypass here is a billing boundary, not a security one.
router.use(requireModule('exports'));
router.get('/:report', requireRole(...FINANCE_ROLES), exportReport);

export default router;
