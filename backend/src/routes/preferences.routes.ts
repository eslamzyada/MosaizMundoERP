import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ADMIN_ROLES, requireRole } from '../middleware/requireRole';
import multer from 'multer';
import {
  getBranding,
  getPreferences,
  updateBranding,
  updatePreferences,
  uploadBrandingLogo,
} from '../controllers/preferences.controller';
import { MAX_LOGO_BYTES } from '../lib/logoStorage';

/**
 * Appearance settings (0032), as TWO routers mounted at their own paths.
 *
 * Deliberately not one router mounted at '/api'. A router mounted there
 * receives every /api/* request, so its `router.use(authMiddleware)` runs for
 * all of them — which broke the Supabase webhook route, that authenticates by
 * HMAC signature and carries no bearer token at all. Mounting each resource at
 * its own noun keeps the middleware where it belongs.
 */

/** MINE. No role gate: nobody needs permission to change their own text size. */
export const preferencesRouter = Router();
preferencesRouter.use(authMiddleware);
preferencesRouter.get('/', getPreferences);
preferencesRouter.put('/', updatePreferences);

/**
 * OURS. Every member reads it — a till prints the logo — but changing the
 * restaurant's identity is administrative, and the 0032 RESTRICTIVE policies
 * enforce that regardless of the gate below.
 */
export const brandingRouter = Router();
brandingRouter.use(authMiddleware);
brandingRouter.get('/', getBranding);
brandingRouter.put('/', requireRole(...ADMIN_ROLES), updateBranding);

/**
 * The image itself. Held in memory rather than written to disk: it is at most
 * 2 MB, it is forwarded straight to Supabase, and a temp file would be one more
 * thing to clean up on a server that may be replaced at any moment.
 *
 * The size limit is enforced here, at the bucket, and in the uploader — the
 * first refusal costs nothing and the last is the one that cannot be bypassed.
 */
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
});

brandingRouter.post(
  '/logo',
  requireRole(...ADMIN_ROLES),
  logoUpload.single('logo'),
  uploadBrandingLogo,
);
