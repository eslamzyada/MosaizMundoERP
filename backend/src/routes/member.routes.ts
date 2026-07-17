import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import {
  inviteMember,
  listInvitations,
  listMembers,
  setMemberRole,
  setMemberActive,
} from '../controllers/member.controller';

// Team / member management. authMiddleware is applied to the whole router, so
// every handler runs inside an authenticated, RLS-bound transaction and must use
// req.tx for all database access.
const router = Router();

router.use(authMiddleware);

// Reading the roster is not privileged — knowing your colleagues is normal.
router.get('/', listMembers);
router.get('/invitations', listInvitations);

// Managing who is in the org, and at what role, IS the privilege boundary.
// Owner-only: this is the operation that can hand out every other permission.
// The 0011 procedures enforce it regardless (plus no-self-service and
// never-strand-the-last-owner); requireRole just makes the refusal legible.
router.post('/invite', requireRole('owner'), inviteMember);
router.patch('/:userId/role', requireRole('owner'), setMemberRole);
router.patch('/:userId/active', requireRole('owner'), setMemberActive);

export default router;
