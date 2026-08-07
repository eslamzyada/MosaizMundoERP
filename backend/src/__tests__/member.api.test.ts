import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createHmac, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

// Member management (0011). Covers the privilege boundary itself: who may hand
// out roles, and the guard rails that stop an org locking itself out.

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the member tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const tokens: Record<string, string> = {};

const invitedEmail = `hire-${randomUUID().slice(0, 8)}@dev.local`;

function sign(userId: string): string {
  return jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Member Org'}, ${`mem-${orgId.slice(0, 8)}`}, 'enterprise')`;
  for (const [id, label, role] of [
    [ownerId, 'mem-owner', 'owner'],
    [cashierId, 'mem-cashier', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = sign(id);
  }
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.organization_invitations WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.users WHERE email = ${invitedEmail}`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('GET /api/members', () => {
  test('any member can read the roster, and it is RLS-scoped', async () => {
    const res = await request(app)
      .get('/api/members')
      .set('Authorization', `Bearer ${tokens.cashier}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((m: { organization_id: string }) => m.organization_id === orgId)).toBe(true);

    const me = res.body.find((m: { user_id: string }) => m.user_id === cashierId);
    expect(me.role).toBe('cashier');
    expect(me.is_self).toBe(true);
    expect(me.email).toContain('mem-cashier');
  });
});

describe('Managing members is owner-only', () => {
  test('cashier cannot invite (403)', async () => {
    const res = await request(app)
      .post('/api/members/invite')
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ email: 'sneaky@dev.local', role: 'owner' });
    expect(res.status).toBe(403);
  });

  test('cashier cannot re-role anyone (403), and nothing changes', async () => {
    const res = await request(app)
      .patch(`/api/members/${ownerId}/role`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ role: 'staff' });
    expect(res.status).toBe(403);

    const rows = await admin.$queryRaw<Array<{ role: string }>>`
      SELECT role FROM public.organization_memberships WHERE user_id = ${ownerId}::uuid`;
    expect(rows[0].role).toBe('owner');
  });
});

describe('Owner guard rails', () => {
  test('owner cannot change their OWN role (403)', async () => {
    const res = await request(app)
      .patch(`/api/members/${ownerId}/role`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ role: 'staff' });
    expect(res.status).toBe(403);
  });

  test('owner cannot deactivate themselves (403) — no lockout', async () => {
    const res = await request(app)
      .patch(`/api/members/${ownerId}/active`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: false });
    expect(res.status).toBe(403);
  });

  test('owner CAN re-role another member, and it takes effect', async () => {
    const res = await request(app)
      .patch(`/api/members/${cashierId}/role`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ role: 'branch_manager' });
    expect(res.status).toBe(200);

    // The new role is live: GET /api/me reflects it immediately.
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${tokens.cashier}`);
    expect(me.body.role).toBe('branch_manager');

    // ...and the promoted member can now do administrative work. Put it back.
    await request(app)
      .patch(`/api/members/${cashierId}/role`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ role: 'cashier' });
  });

  test('rejects an unknown role (400)', async () => {
    const res = await request(app)
      .patch(`/api/members/${cashierId}/role`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ role: 'superuser' });
    expect(res.status).toBe(400);
  });

  test('owner CAN deactivate another member', async () => {
    const res = await request(app)
      .patch(`/api/members/${cashierId}/active`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);

    // A deactivated membership resolves nothing — /api/me is now 404, and RLS
    // shows them nothing, rather than leaving them half-logged-in.
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${tokens.cashier}`);
    expect(me.status).toBe(404);

    await request(app)
      .patch(`/api/members/${cashierId}/active`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: true });
  });
});

describe('Invitations', () => {
  test('owner invites; it appears as pending', async () => {
    const res = await request(app)
      .post('/api/members/invite')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ email: invitedEmail, role: 'cashier' });
    expect(res.status).toBe(201);

    const list = await request(app)
      .get('/api/members/invitations')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(list.status).toBe(200);
    expect(list.body.some((i: { email: string }) => i.email === invitedEmail)).toBe(true);
  });

  test('a duplicate open invitation is refused (409)', async () => {
    const res = await request(app)
      .post('/api/members/invite')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ email: invitedEmail, role: 'staff' });
    expect(res.status).toBe(409);
  });

  test('inviting an existing member is refused (400)', async () => {
    const existing = await admin.$queryRaw<Array<{ email: string }>>`
      SELECT email FROM public.users WHERE id = ${cashierId}::uuid`;
    const res = await request(app)
      .post('/api/members/invite')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ email: existing[0].email, role: 'staff' });
    expect(res.status).toBe(400);
  });

  test('signup consumes the invitation: the invitee joins THIS org, not a new one', async () => {
    const newUserId = randomUUID();

    // Exactly what Supabase posts, signed the same way.
    const raw = JSON.stringify({ record: { id: newUserId, email: invitedEmail } });
    const signature = createHmac('sha256', process.env.SUPABASE_WEBHOOK_SECRET as string)
      .update(raw)
      .digest('hex');

    const hook = await request(app)
      .post('/api/webhooks/supabase')
      .set('Content-Type', 'application/json')
      .set('x-supabase-signature', signature)
      .send(raw);
    expect(hook.status).toBe(200);
    expect(hook.body.message).toBe('Invitation accepted');

    const memberships = await admin.$queryRaw<Array<{ organization_id: string; role: string }>>`
      SELECT organization_id, role FROM public.organization_memberships WHERE user_id = ${newUserId}::uuid`;
    // Exactly one membership, in the inviting org — no junk tenant.
    expect(memberships).toHaveLength(1);
    expect(memberships[0].organization_id).toBe(orgId);
    expect(memberships[0].role).toBe('cashier');

    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE user_id = ${newUserId}::uuid`;
    await admin.$executeRaw`DELETE FROM public.users WHERE id = ${newUserId}::uuid`;
  });
});
