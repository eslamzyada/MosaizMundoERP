import { Router } from 'express';
import { webhookAuth } from '../middleware/webhookAuth';
import { handleSupabaseUserSignup } from '../controllers/webhook.controller';

// Webhook routes. These are called by Supabase (a backend system), NOT by a
// logged-in user, so they are guarded by HMAC signature verification instead of
// the JWT auth middleware.
const router = Router();

router.post('/supabase', webhookAuth, handleSupabaseUserSignup);

export default router;
