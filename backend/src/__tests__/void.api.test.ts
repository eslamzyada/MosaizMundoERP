import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the void tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const itemId = randomUUID(); // price 10, recipe: 2 units of the ingredient
const rawId = randomUUID(); // one lot: 20 units @ 2.00

// A second tenant whose order must be unreachable.
const orgBId = randomUUID();
const userBId = randomUUID();
const itemBId = randomUUID();
let orderBId: string;

const tokens: Record<string, string> = {};

async function checkout(qty: number): Promise<string> {
  const res = await request(app)
    .post('/api/pos/checkout')
    .set('Authorization', `Bearer ${tokens.owner}`)
    .send({
      organization_id: orgId,
      client_offline_id: randomUUID(),
      items: [{ sellable_item_id: itemId, quantity: qty }],
    });
  expect(res.status).toBe(200);
  expect(res.body.order_id).toBeTruthy();
  return res.body.order_id as string;
}

async function voidVia(
  who: string,
  orderId: string,
  restore: unknown,
): Promise<request.Response> {
  return request(app)
    .post(`/api/pos/orders/${orderId}/void`)
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send(restore === undefined ? {} : { restore_stock: restore });
}

async function stockOnHand(): Promise<number> {
  const [row] = await admin.$queryRaw<Array<{ on_hand: unknown }>>`
    SELECT COALESCE(sum(quantity_remaining), 0) AS on_hand
    FROM public.inventory_batches WHERE raw_item_id = ${rawId}::uuid`;
  return Number(row.on_hand);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Void Org'}, ${`void-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'void-owner', 'owner'],
    [cashierId, 'void-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${itemId}::uuid, ${orgId}::uuid, ${'Void Dish'}, ${'VOID-1'}, 10)`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${rawId}::uuid, ${orgId}::uuid, ${'Void Flour'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${itemId}::uuid, ${rawId}::uuid, 2)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${rawId}::uuid, 20, 20, 2.00)`;

  // Tenant B, with one completed order.
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Void Org B'}, ${`void-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`void-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${itemBId}::uuid, ${orgBId}::uuid, ${'B Dish'}, ${'VOID-B'}, 99)`;
  orderBId = randomUUID();
  await admin.$executeRaw`INSERT INTO public.orders (id, organization_id, client_offline_id, total_amount) VALUES (${orderBId}::uuid, ${orgBId}::uuid, ${randomUUID()}::uuid, 99)`;
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${org}::uuid`;
    // Deleting the orders cascades their inventory_consumption rows, which must
    // go before the batches they reference.
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Order void API', () => {
  test('void with restore returns the consumed stock to its lot', async () => {
    const orderId = await checkout(3); // 6 units consumed
    expect(await stockOnHand()).toBeCloseTo(14, 6);

    const res = await voidVia('owner', orderId, true);
    expect(res.status).toBe(200);
    expect(res.body.stock_restored).toBe(true);

    expect(await stockOnHand()).toBeCloseTo(20, 6);

    const [order] = await admin.$queryRaw<
      Array<{ status: string; stock_restored: boolean; voided_by: string }>
    >`SELECT status, stock_restored, voided_by FROM public.orders WHERE id = ${orderId}::uuid`;
    expect(order.status).toBe('voided');
    expect(order.stock_restored).toBe(true);
    expect(order.voided_by).toBe(ownerId);

    // The ledger survives: the record of what happened is not unwound.
    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.inventory_consumption WHERE order_id = ${orderId}::uuid`;
    expect(rows.length).toBe(1);
  });

  test('void without restore corrects the money and leaves the shelf alone', async () => {
    const orderId = await checkout(2); // 4 units consumed -> 16 left
    expect(await stockOnHand()).toBeCloseTo(16, 6);

    const res = await voidVia('owner', orderId, false);
    expect(res.status).toBe(200);

    expect(await stockOnHand()).toBeCloseTo(16, 6);

    const [order] = await admin.$queryRaw<Array<{ status: string; stock_restored: boolean }>>`
      SELECT status, stock_restored FROM public.orders WHERE id = ${orderId}::uuid`;
    expect(order.status).toBe('voided');
    expect(order.stock_restored).toBe(false);
  });

  test('re-voiding is 409 and does not restore twice', async () => {
    const orderId = await checkout(1); // 2 units -> 14 left
    await voidVia('owner', orderId, true); // -> back to 16

    const again = await voidVia('owner', orderId, true);
    expect(again.status).toBe(409);
    expect(await stockOnHand()).toBeCloseTo(16, 6);
  });

  test('a cashier may not void (403), and the order is untouched', async () => {
    const orderId = await checkout(1); // -> 14 left

    const res = await voidVia('cashier', orderId, true);
    expect(res.status).toBe(403);

    const [order] = await admin.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM public.orders WHERE id = ${orderId}::uuid`;
    expect(order.status).toBe('completed');
    expect(await stockOnHand()).toBeCloseTo(14, 6);
  });

  test("another tenant's order is 404, not 403 — its existence is not confirmed", async () => {
    const res = await voidVia('owner', orderBId, true);
    expect(res.status).toBe(404);

    const [order] = await admin.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM public.orders WHERE id = ${orderBId}::uuid`;
    expect(order.status).toBe('completed');
  });

  test('a nonexistent order is 404', async () => {
    const res = await voidVia('owner', randomUUID(), false);
    expect(res.status).toBe(404);
  });

  test('restore_stock is mandatory and boolean — no silent default', async () => {
    const orderId = await checkout(1);

    for (const bad of [undefined, 'yes', 1, null]) {
      const res = await voidVia('owner', orderId, bad);
      expect(res.status).toBe(400);
    }
    // The refused requests changed nothing.
    const [order] = await admin.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM public.orders WHERE id = ${orderId}::uuid`;
    expect(order.status).toBe('completed');
  });

  test('a malformed id is 400', async () => {
    const res = await request(app)
      .post('/api/pos/orders/not-a-uuid/void')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ restore_stock: true });
    expect(res.status).toBe(400);
  });

  test('voided orders vanish from profitability revenue', async () => {
    // From the sequence above, exactly two orders remain completed: the
    // cashier-blocked one (qty 1) and the validation one (qty 1) — 20.00.
    const res = await request(app)
      .get('/api/reports/profitability?days=30')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.revenue).toBeCloseTo(20, 6);
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app)
      .post(`/api/pos/orders/${randomUUID()}/void`)
      .send({ restore_stock: true });
    expect(res.status).toBe(401);
  });
});
