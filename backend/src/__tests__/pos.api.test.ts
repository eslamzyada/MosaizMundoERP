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

// A second, separate tenant used by the cross-tenant attack test.
const userBId = randomUUID();
const orgBId = randomUUID();
const slugB = `jest-b-${userBId.slice(0, 8)}`;

let token: string;

beforeAll(async () => {
  // Seed as superuser (bypasses RLS).
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`jest-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Jest Org'}, ${slug}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${itemId}::uuid, ${orgId}::uuid, ${'Jest Burger'}, ${'JEST-1'}, 12.50)`;

  // Tenant B: a different owner/org that Tenant A is NOT a member of.
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`jest-b-${userBId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Jest Org B'}, ${slugB}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;

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

  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgBId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgBId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${userBId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgBId}::uuid`;

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

  test('POST /api/pos/checkout ignores client-supplied prices (F-01) and returns an order_id', async () => {
    const coid = randomUUID();
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({
        organization_id: orgId,
        client_offline_id: coid,
        total_amount: 0.01, // a lie
        items: [{ sellable_item_id: itemId, quantity: 2, unit_price: 0.01 }], // a lie
      });

    expect(res.status).toBe(200);
    expect(res.body.order_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // The database priced from the catalog (12.50 x 2 = 25.00), not the payload.
    const rows = await admin.$queryRaw<Array<{ total_amount: unknown; unit_price: unknown }>>`
      SELECT o.total_amount, oi.unit_price
      FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
      WHERE o.client_offline_id = ${coid}::uuid`;
    expect(Number(rows[0].total_amount)).toBe(25);
    expect(Number(rows[0].unit_price)).toBe(12.5);
  });

  test('GET /api/pos/orders returns orders with nested items and numeric Decimals', async () => {
    // Seed a known order + line item (superuser bypasses RLS).
    const orderId = randomUUID();
    await admin.$executeRaw`INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount) VALUES (${orderId}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 'completed', 42.50)`;
    await admin.$executeRaw`INSERT INTO public.order_items (order_id, organization_id, sellable_item_id, quantity, unit_price) VALUES (${orderId}::uuid, ${orgId}::uuid, ${itemId}::uuid, 3, 14.00)`;

    const res = await request(app)
      .get('/api/pos/orders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const order = res.body.find((o: { id: string }) => o.id === orderId);
    expect(order).toBeDefined();

    // Decimal serialization fix: total_amount / unit_price are JSON numbers.
    expect(typeof order.total_amount).toBe('number');
    expect(order.total_amount).toBe(42.5);

    expect(Array.isArray(order.order_items)).toBe(true);
    const line = order.order_items[0];
    expect(typeof line.unit_price).toBe('number');
    expect(line.unit_price).toBe(14);
    expect(typeof line.quantity).toBe('number');
    expect(line.quantity).toBe(3);
  });

  test('GET /api/pos/orders paginates with limit & offset (F-04)', async () => {
    // Seed a handful of orders (superuser) so there is more than one page.
    for (let i = 0; i < 5; i += 1) {
      await admin.$executeRaw`INSERT INTO public.orders (organization_id, client_offline_id, total_amount) VALUES (${orgId}::uuid, ${randomUUID()}::uuid, ${i + 1})`;
    }

    const page1 = await request(app)
      .get('/api/pos/orders?limit=3')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body).toHaveLength(3);

    const page2 = await request(app)
      .get('/api/pos/orders?limit=3&offset=3')
      .set('Authorization', `Bearer ${token}`);
    expect(page2.status).toBe(200);
    expect(page2.body.length).toBeGreaterThan(0);

    // Distinct pages: no id appears on both.
    const firstIds = new Set(page1.body.map((o: { id: string }) => o.id));
    expect(page2.body.some((o: { id: string }) => firstIds.has(o.id))).toBe(false);
  });

  test('an unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/pos/menu');
    expect(res.status).toBe(401);
  });

  test('an expired JWT is rejected with 401', async () => {
    const expired = jwt.sign(
      { sub: userId, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: -60 },
    );
    const res = await request(app)
      .get('/api/pos/menu')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  test('a cross-tenant checkout is rejected and writes nothing', async () => {
    // Authenticated as Tenant A, but the payload names Tenant B's org. Tenant
    // B's catalog isn't visible to A, so 0012 rejects the line as unavailable
    // before any write; the orders WITH CHECK would also block it. Either way
    // the checkout is refused (400) and nothing lands in Tenant B.
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({
        organization_id: orgBId,
        client_offline_id: randomUUID(),
        total_amount: 5.0,
        items: [{ sellable_item_id: itemId, quantity: 1, unit_price: 5.0 }],
      });
    expect(res.status).toBe(400);

    const leaked = await admin.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.orders WHERE organization_id = ${orgBId}::uuid`;
    expect(Number(leaked[0].n)).toBe(0);
  });
});
