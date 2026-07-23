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
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the POS orders tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();
const burgerId = randomUUID();
const pattyId = randomUUID();

const tokens: Record<string, string> = {};

interface OrderLine {
  sellable_item_id: string;
  quantity: number;
  unit_price: number;
  sellable_items: { name: string; sku: string | null };
}
interface Order {
  id: string;
  status: string;
  total_amount: number;
  stock_restored: boolean | null;
  order_items: OrderLine[];
}

async function orders(who: string): Promise<Order[]> {
  const res = await request(app)
    .get('/api/pos/orders')
    .set('Authorization', `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body as Order[];
}

/** Rings up `qty` burgers as the cashier, exactly as the till would. */
async function sell(qty: number): Promise<string> {
  const res = await request(app)
    .post('/api/pos/checkout')
    .set('Authorization', `Bearer ${tokens.cashier}`)
    .send({
      organization_id: orgId,
      client_offline_id: randomUUID(),
      items: [{ sellable_item_id: burgerId, quantity: qty }],
    });
  expect(res.status).toBe(200);
  return res.body.order_id as string;
}

async function onHand(): Promise<number> {
  const [row] = await admin.$queryRaw<Array<{ q: unknown }>>`
    SELECT COALESCE(sum(quantity_remaining), 0) AS q
    FROM public.inventory_batches WHERE raw_item_id = ${pattyId}::uuid`;
  return Number(row.q);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Till Org'}, ${`till-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [managerId, 'till-mgr', 'branch_manager'],
    [cashierId, 'till-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }
  tokens.manager = jwt.sign(
    { sub: managerId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
  tokens.cashier = jwt.sign(
    { sub: cashierId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${burgerId}::uuid, ${orgId}::uuid, ${'Till Burger'}, ${'TILL-BRG'}, 50)`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${pattyId}::uuid, ${orgId}::uuid, ${'Till Patty'}, ${'pieces'})`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${burgerId}::uuid, ${pattyId}::uuid, 1)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${pattyId}::uuid, 100, 100, 2)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.inventory_consumption WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_deficits WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('POS order history', () => {
  test('each line names its item, so a till can tell two orders apart', async () => {
    const orderId = await sell(2);
    const order = (await orders('cashier')).find((o) => o.id === orderId)!;

    const line = order.order_items[0];
    // An id is not identification when two orders share a total.
    expect(line.sellable_items.name).toBe('Till Burger');
    expect(line.sellable_items.sku).toBe('TILL-BRG');
    expect(line.quantity).toBe(2);
    expect(Number(line.unit_price)).toBeCloseTo(50, 6);
  });

  test('a cashier may read history — they need to find their own mistake', async () => {
    const res = await request(app)
      .get('/api/pos/orders')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(res.status).toBe(200);
  });
});

describe('Voiding from the till', () => {
  test('a cashier alone cannot void, and nothing moves', async () => {
    const orderId = await sell(1);
    const before = await onHand();

    const res = await request(app)
      .post(`/api/pos/orders/${orderId}/void`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ restore_stock: true, void_reason: 'wrong_item' });
    expect(res.status).toBe(403);

    const order = (await orders('cashier')).find((o) => o.id === orderId)!;
    expect(order.status).toBe('completed');
    expect(await onHand()).toBeCloseTo(before, 6);
  });

  test("a manager's authorisation voids the same order and returns the stock", async () => {
    const orderId = await sell(3);
    const afterSale = await onHand();

    // The till holds a cashier session; the manager's token authorises this one
    // call. Nothing about the cashier's session changes.
    const res = await request(app)
      .post(`/api/pos/orders/${orderId}/void`)
      .set('Authorization', `Bearer ${tokens.manager}`)
      .send({ restore_stock: true, void_reason: 'wrong_item' });
    expect(res.status).toBe(200);

    // Three patties come back.
    expect(await onHand()).toBeCloseTo(afterSale + 3, 6);

    const order = (await orders('cashier')).find((o) => o.id === orderId)!;
    expect(order.status).toBe('voided');
    expect(order.stock_restored).toBe(true);

    // The cashier's own session still works — it was never replaced.
    const stillWorks = await request(app)
      .get('/api/pos/menu')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(stillWorks.status).toBe(200);
  });

  test('the food-was-made answer is required — there is no safe default', async () => {
    const orderId = await sell(1);

    const res = await request(app)
      .post(`/api/pos/orders/${orderId}/void`)
      .set('Authorization', `Bearer ${tokens.manager}`)
      .send({});
    expect(res.status).toBe(400);

    const order = (await orders('manager')).find((o) => o.id === orderId)!;
    expect(order.status).toBe('completed');
  });

  test('voiding without restoring leaves the stock deducted', async () => {
    const orderId = await sell(2);
    const afterSale = await onHand();

    const res = await request(app)
      .post(`/api/pos/orders/${orderId}/void`)
      .set('Authorization', `Bearer ${tokens.manager}`)
      .send({ restore_stock: false, void_reason: 'kitchen_error' });
    expect(res.status).toBe(200);

    // The food was made: the patties are gone regardless of the refund.
    expect(await onHand()).toBeCloseTo(afterSale, 6);
    const order = (await orders('manager')).find((o) => o.id === orderId)!;
    expect(order.stock_restored).toBe(false);
  });

  test('a voided order shows as voided in the till history', async () => {
    const voided = (await orders('cashier')).filter((o) => o.status === 'voided');
    // The till must be able to see it is already done, or a cashier will try again.
    expect(voided.length).toBeGreaterThan(0);
  });
});
