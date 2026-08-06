import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireModule } from '../middleware/requireModule';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import {
  accept,
  getStorefront,
  listQueue,
  reject,
  saveStorefront,
} from '../controllers/publicOrder.controller';

/**
 * The staff side of the shopfront (0040).
 *
 * Note what is NOT gated by role: accepting and rejecting. Whoever is at the
 * pass when the tablet pings deals with it — the database's user_can_sell
 * policy keeps the accountant out, and the checkout that acceptance triggers
 * applies its own rules under that person's identity.
 *
 * Naming the shopfront IS administration: the slug is the restaurant's public
 * address and changing it breaks every printed menu.
 */
const router = Router();

router.use(authMiddleware);
router.use(requireModule('public_ordering'));

router.get('/storefront', getStorefront);
router.put('/storefront', requireRole(...ADMIN_ROLES), saveStorefront);

router.get('/', listQueue);
router.post('/:id/accept', accept);
router.post('/:id/reject', reject);

export default router;
