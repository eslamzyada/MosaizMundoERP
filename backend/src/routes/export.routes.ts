import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { FINANCE_ROLES, requireRole } from '../middleware/requireRole';
import { exportReport } from '../controllers/export.controller';

/**
 * Reports as files.
 *
 * The same FINANCE_ROLES gate as the reports themselves — a PDF of the margins
 * is still the margins, and a file is easier to forward than a screen.
 */
const router = Router();

router.use(authMiddleware);
router.get('/:report', requireRole(...FINANCE_ROLES), exportReport);

export default router;
