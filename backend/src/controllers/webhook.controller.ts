import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') {
      return meta.code;
    }
  }
  return undefined;
}

// Builds a schema-valid organizations.slug (CHECK: ^[a-z0-9]+(-[a-z0-9]+)*$)
// from the email plus a slice of the user id, so it is readable and unique per
// user. Empty segments are dropped so we never emit a leading/double dash.
function buildOrgSlug(email: string, userId: string): string {
  const emailPart = email.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const idPart = userId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return ['org', emailPart, idPart].filter(Boolean).join('-');
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/webhooks/supabase
 *
 * Handles a Supabase "new auth user" event. Two outcomes, and the order matters:
 *
 *   1. INVITED (0011) — an owner already invited this email, so the identity
 *      joins THAT organization with the invited role.
 *   2. Otherwise — a brand new tenant (user + organization + owner membership).
 *
 * Invitations must be checked FIRST. Provisioning always creates a new org with
 * the signer-up as its owner, so a staff member would otherwise be handed their
 * own empty restaurant — and since GET /api/me resolves the EARLIEST membership,
 * adding them to the real org afterwards would still land them in the junk one.
 *
 * Both paths are system-level actions that cross the RLS boundary, so they go
 * through SECURITY DEFINER procedures. mosaiz_app_user holds EXECUTE on them,
 * so the global prisma client (no per-request tx — nobody is logged in here)
 * can call them.
 */
export async function handleSupabaseUserSignup(req: Request, res: Response): Promise<void> {
  const record = (req.body as { record?: { id?: unknown; email?: unknown } })?.record;
  const id = record?.id;
  const email = record?.email;

  if (typeof id !== 'string' || !UUID_RE.test(id) || typeof email !== 'string' || !email) {
    res.status(400).json({ error: 'Payload must include record.id (uuid) and record.email' });
    return;
  }

  const orgName = `Org - ${email}`;
  const orgSlug = buildOrgSlug(email, id);
  // NOTE: the schema's plan_tier CHECK allows basic/standard/premium/enterprise
  // (no 'free'), so new tenants get 'basic' — the default entry tier. Adding a
  // literal 'free' tier would require a new migration + test.
  const planTier = 'basic';

  try {
    // Invited? Then join that org — and do NOT mint a new tenant.
    const accepted = await prisma.$queryRaw<Array<{ accepted: boolean }>>`
      SELECT app.accept_invitation(${id}::uuid, ${email}) AS accepted`;

    if (accepted[0]?.accepted) {
      res.status(200).json({ status: 'ok', message: 'Invitation accepted', user_id: id });
      return;
    }

    await prisma.$executeRaw`CALL app.provision_new_tenant(${id}::uuid, ${email}, ${orgName}, ${orgSlug}, ${planTier})`;
    res.status(200).json({ status: 'ok', message: 'Tenant provisioned', user_id: id });
  } catch (err) {
    logger.error('webhook.signup provisioning failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });

    // A unique violation means this identity was already provisioned (Supabase
    // retried the delivery). That is success from the webhook's perspective —
    // return 2xx so the retry loop stops.
    if (postgresErrorCode(err) === '23505') {
      res.status(200).json({ status: 'ok', message: 'Tenant already provisioned', user_id: id });
      return;
    }

    res.status(500).json({ error: 'Provisioning failed' });
  }
}
