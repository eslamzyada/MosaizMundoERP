import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

// The app connects as the RLS-constrained mosaiz_app_user (DATABASE_URL). Test
// seeding/teardown needs to bypass RLS and reach tables the app role can't
// DELETE, so it uses a privileged connection (ADMIN_DATABASE_URL = postgres).
const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the API tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

// A fresh, uniquely-identified tenant per run so tests never collide with
// leftover data (the SQL suites run first in CI and leave rows behind).
const userId = randomUUID();
const orgId = randomUUID();
const itemId = randomUUID();
const slug = `jest-${userId.slice(0, 8)}`;

let token: string;

beforeAll(async () => {
  // Seed as superuser (bypasses RLS).
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`jest-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Jest Org'}, ${slug}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku) VALUES (${itemId}::uuid, ${orgId}::uuid, ${'Jest Burger'}, ${'JEST-1'})`;

  token = jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  // FK-safe teardown (superuser).
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${userId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('POS API', () => {
  test('GET /api/pos/menu returns 200 and the org catalog', async () => {
    const res = await request(app)
      .get('/api/pos/menu')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // RLS-scoped: the seeded item is present, and every item belongs to our org.
    expect(res.body.some((i: { id: string }) => i.id === itemId)).toBe(true);
    expect(
      res.body.every((i: { organization_id: string }) => i.organization_id === orgId),
    ).toBe(true);
  });

  test('POST /api/pos/checkout returns 200 and an order_id', async () => {
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({
        organization_id: orgId,
        client_offline_id: randomUUID(),
        total_amount: 12.5,
        items: [{ sellable_item_id: itemId, quantity: 1, unit_price: 12.5 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.order_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('an unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/pos/menu');
    expect(res.status).toBe(401);
  });
});
