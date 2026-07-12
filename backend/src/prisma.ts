import { PrismaClient } from '@prisma/client';

// A single shared client. It connects as mosaiz_app_user (see DATABASE_URL) —
// the RLS-constrained application role — so every query is subject to Row
// Level Security. The per-request transaction in the auth middleware is what
// supplies the `app.current_user_id` the RLS policies read.
export const prisma = new PrismaClient();
