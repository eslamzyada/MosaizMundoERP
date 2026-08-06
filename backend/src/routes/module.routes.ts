import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { listModules, setModule } from '../controllers/module.controller';

/**
 * What this restaurant runs (0037).
 *
 * Reading is open to every member on purpose: a waiter who cannot find الجرد
 * should be able to see that their restaurant does not do stocktakes, rather
 * than conclude the app is broken.
 *
 * Writing has no requireRole here, and that is deliberate too — app.set_module
 * does the check itself, together with the dependency rules it cannot be
 * separated from. A gate here would be a second opinion about who may decide,
 * and the two would eventually disagree.
 */
const router = Router();

router.use(authMiddleware);

router.get('/', listModules);
router.put('/:key', setModule);

export default router;
