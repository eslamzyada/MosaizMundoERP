import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getMe } from '../controllers/user.controller';

// User/session routes. authMiddleware binds the RLS identity, so getMe can read
// the caller's membership via req.tx.
const router = Router();

router.use(authMiddleware);

router.get('/', getMe);

export default router;
