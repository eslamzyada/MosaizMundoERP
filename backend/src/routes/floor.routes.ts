import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getFloor } from '../controllers/floor.controller';

/**
 * The room, in one request (0045).
 *
 * NO role gate. Everyone who works a service needs to see the floor — it is
 * the waiter's home screen, and a kitchen or a manager asking "which tables are
 * still running" is asking a question their job depends on. Nothing here is
 * money-shaped beyond the running total of a tab, which anybody carrying plates
 * to that table can already read off the till.
 *
 * NO module gate either, and that is deliberate. The floor plan belongs to the
 * `reservations` module, but a restaurant without it still has tabs — they just
 * have no tables to sit at. The controller answers `tables: null` for those
 * rather than refusing the request, because "you have no floor plan" is an
 * answer this screen can render and a 409 is not.
 */
const router = Router();

router.use(authMiddleware);

router.get('/', getFloor);

export default router;
