import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { closeTill, getTill, openTill } from '../controllers/till.controller';

/**
 * The drawer (0047).
 *
 * NO requireRole here. Both procedures ask app.user_can_sell themselves, and a
 * gate up here could only ever disagree with the one that actually decides.
 * That is deliberate policy as well as convention: whoever may take money must
 * be able to open the drawer they take it into, or a cashier rings up sales
 * that belong to no cash-up — the exact failure 0047 exists to remove.
 *
 * NO module gate either. Every restaurant that handles cash needs this, and it
 * is not something anybody should be able to switch off to avoid being counted.
 */
const router = Router();

router.use(authMiddleware);

router.get('/', getTill);
router.post('/open', openTill);
router.post('/close', closeTill);

export default router;
