import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

// Role-based authorization (0010 + requireRole). Every OTHER suite provisions
// its user as 'owner', so none of them would notice a role regression — this is
// the only place the non-owner roles are exercised.

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the RBAC tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const accountantId = randomUUID();
const rawItemId = randomUUID();
const sellableId = randomUUID();

const tokens: Record<string, string> = {};

function sign(userId: string): string {
  return jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'RBAC API Org'}, ${`rbac-${orgId.slice(0, 8)}`}, 'enterprise')`;

  for (const [id, email, role] of [
    [ownerId, 'rbac-owner', 'owner'],
    [cashierId, 'rbac-cashier', 'cashier'],
    [accountantId, 'rbac-accountant', 'accountant'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${email}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = sign(id);
  }

  // Catalog + a recipe + stock, so a sale has something to draw down.
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${rawItemId}::uuid, ${orgId}::uuid, ${'RBAC Chicken'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${sellableId}::uuid, ${orgId}::uuid, ${'RBAC Wrap'}, 50.00)`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${sellableId}::uuid, ${rawItemId}::uuid, 10)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${rawItemId}::uuid, 1000, 1000, 0.10)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_deficits WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${accountantId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('GET /api/me exposes the role', () => {
  test.each([
    ['owner'],
    ['cashier'],
    ['accountant'],
  ])('returns role "%s"', async (role) => {
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${tokens[role]}`);
    expect(res.status).toBe(200);
    expect(res.body.organization_id).toBe(orgId);
    expect(res.body.role).toBe(role);
  });
});

describe('Reads stay open to every role', () => {
  test.each([['owner'], ['cashier'], ['accountant']])(
    '%s can read stock',
    async (role) => {
      const res = await request(app)
        .get('/api/inventory/stock')
        .set('Authorization', `Bearer ${tokens[role]}`);
      expect(res.status).toBe(200);
      expect(res.body.some((r: { id: string }) => r.id === rawItemId)).toBe(true);
    },
  );
});

describe('Receiving stock is administrative', () => {
  test('owner can receive stock (201)', async () => {
    const res = await request(app)
      .post('/api/inventory/receive')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ raw_item_id: rawItemId, quantity_received: 100, cost_at_purchase: 0.2 });
    expect(res.status).toBe(201);
  });

  test.each([['cashier'], ['accountant']])('%s is refused (403)', async (role) => {
    const res = await request(app)
      .post('/api/inventory/receive')
      .set('Authorization', `Bearer ${tokens[role]}`)
      .send({ raw_item_id: rawItemId, quantity_received: 999, cost_at_purchase: 0.2 });

    expect(res.status).toBe(403);
    expect(res.body.role).toBe(role);
  });

  test('a refused receive writes NOTHING (the database is the real gate)', async () => {
    const before = await admin.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.inventory_batches WHERE organization_id = ${orgId}::uuid`;
    await request(app)
      .post('/api/inventory/receive')
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ raw_item_id: rawItemId, quantity_received: 999, cost_at_purchase: 0.2 });
    const after = await admin.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.inventory_batches WHERE organization_id = ${orgId}::uuid`;
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });
});

describe('Editing a recipe is administrative', () => {
  test('cashier is refused (403)', async () => {
    const res = await request(app)
      .post(`/api/recipes/${sellableId}/lines`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ raw_item_id: rawItemId, quantity_required: 5 });
    expect(res.status).toBe(403);
  });
});

describe('Selling follows the seller, not the administrator', () => {
  test('cashier CAN check out — and stock still draws down', async () => {
    const before = await admin.$queryRaw<Array<{ q: unknown }>>`
      SELECT COALESCE(sum(quantity_remaining), 0) AS q FROM public.inventory_batches WHERE raw_item_id = ${rawItemId}::uuid`;

    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({
        organization_id: orgId,
        client_offline_id: randomUUID(),
        total_amount: 100,
        items: [{ sellable_item_id: sellableId, quantity: 2, unit_price: 50 }],
      });
    expect([200, 201]).toContain(res.status);

    const after = await admin.$queryRaw<Array<{ q: unknown }>>`
      SELECT COALESCE(sum(quantity_remaining), 0) AS q FROM public.inventory_batches WHERE raw_item_id = ${rawItemId}::uuid`;
    // 2 wraps x 10g. Proves the role gate did not break the SECURITY INVOKER
    // deduction that runs as the cashier.
    expect(Number(before[0].q) - Number(after[0].q)).toBe(20);
  });

  test('accountant is refused (403) — read-only', async () => {
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${tokens.accountant}`)
      .send({
        organization_id: orgId,
        client_offline_id: randomUUID(),
        total_amount: 50,
        items: [{ sellable_item_id: sellableId, quantity: 1, unit_price: 50 }],
      });
    expect(res.status).toBe(403);
  });
});
