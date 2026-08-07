import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireModule } from '../middleware/requireModule';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  availability,
  createReservation,
  createTable,
  listReservations,
  listTables,
  seat,
  setStatus,
  updateTable,
} from '../controllers/reservation.controller';

/**
 * Tables and bookings (0039).
 *
 * The split that matters: defining the FLOOR PLAN is administration, taking a
 * BOOKING is floor work. The person who answers the phone is whoever is
 * nearest it, and requiring a manager for that would mean the phone goes
 * unanswered — so there is no role gate on the booking routes, and the
 * database's `user_can_sell` policy is what keeps the accountant out.
 */
const router = Router();

router.use(authMiddleware);
router.use(requireModule('reservations'));

// The floor plan: everyone reads it, management defines it.
router.get('/tables', listTables);
router.post('/tables', requireRole(...ADMIN_ROLES), createTable);
router.patch('/tables/:id', requireRole(...ADMIN_ROLES), updateTable);

// The book.
router.get('/', listReservations);
router.get('/availability', availability);
router.post('/', createReservation);
router.post('/:id/status', setStatus);

// Sitting the party down (0043). Floor work, like taking the booking was —
// and it opens a real tab, so the database runs it as whoever pressed it.
router.post('/:id/seat', seat);

export default router;
