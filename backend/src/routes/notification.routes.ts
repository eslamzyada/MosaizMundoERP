import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  listNotifications,
  markAllRead,
  markRead,
} from '../controllers/notification.controller';

/**
 * Your own inbox (0036).
 *
 * No role gate anywhere, on purpose: every role has an inbox, and what is IN it
 * was decided when the event happened by a function that picked recipients by
 * role. The own-row policy is what scopes these reads — a requireRole here
 * would gate the wrong thing and could only ever disagree with the policy.
 *
 * There is deliberately no send endpoint. The application role cannot INSERT.
 */
const router = Router();

router.use(authMiddleware);

// A fixed segment, declared first so that a later /:id route cannot swallow it.
router.post('/read-all', markAllRead);

router.get('/', listNotifications);
router.post('/:id/read', markRead);

export default router;
