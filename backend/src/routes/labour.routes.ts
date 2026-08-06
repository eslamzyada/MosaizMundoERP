import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireModule } from '../middleware/requireModule';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  amendEntry,
  clockIn,
  clockOut,
  createShift,
  currentEntry,
  deleteShift,
  hours,
  listShifts,
} from '../controllers/labour.controller';

/**
 * The rota and the clock (0038).
 *
 * requireModule sits on the whole router: with labour switched off there is
 * nothing here a restaurant wants, and a 409 naming the module is a better
 * answer than each endpoint failing in its own way. The database refuses these
 * writes regardless — the procedures ask org_has_module themselves precisely
 * because SECURITY DEFINER puts them outside RLS.
 *
 * Note what is NOT gated by role: clock-in, clock-out and "am I clocked in".
 * Those are things a person does about themselves, and every role has a self.
 */
const router = Router();

router.use(authMiddleware);
router.use(requireModule('labour'));

// The rota. Reading is open — a schedule nobody can see is a schedule nobody
// follows — and writing is a manager's act, refused by 0010 as well as here.
router.get('/shifts', listShifts);
router.post('/shifts', requireRole(...ADMIN_ROLES), createShift);
router.delete('/shifts/:id', requireRole(...ADMIN_ROLES), deleteShift);

// The clock. Yours, about you.
router.get('/clock', currentEntry);
router.post('/clock-in', clockIn);
router.post('/clock-out', clockOut);

// Hours. One endpoint, scoped by the own-row policy: a waiter sees their own,
// a manager sees everybody's, and there is no role branch in the handler to
// get that wrong.
router.get('/hours', hours);

router.post('/entries/:id/amend', requireRole(...ADMIN_ROLES), amendEntry);

export default router;
