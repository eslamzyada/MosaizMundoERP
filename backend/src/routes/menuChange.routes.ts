import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  decideChange,
  listChanges,
  proposeChange,
  withdrawChange,
} from '../controllers/menuChange.controller';

/**
 * The menu approval cycle (0035).
 *
 * Deliberately NO requireRole on any of these. Everywhere else in this API the
 * role gate is a courtesy that turns a policy refusal into an honest 403; here
 * the rules are more specific than a role list can express — the proposer may
 * withdraw but not decide, the decider may not decide their own, and a lone
 * approver may. All of that lives in the 0035 policies and in
 * app.decide_menu_change, and a role check in front of it could only ever
 * disagree with it.
 *
 * Reading is open to every member on purpose: a waiter quoting tonight's price
 * should be able to see that it is about to change.
 */
const router = Router();

router.use(authMiddleware);

router.get('/', listChanges);
router.post('/', proposeChange);
router.post('/:id/decide', decideChange);
router.post('/:id/withdraw', withdrawChange);

export default router;
