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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the ingredient lifecycle tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const usedId = randomUUID(); // has a lot, a recipe line and a sale behind it
const dishId = randomUUID();
const orgBId = randomUUID();
const userBId = randomUUID();
const itemBId = randomUUID();

const tokens: Record<string, string> = {};
let usedLot: string;

async function createItem(name: string): Promise<string> {
  const res = await request(app)
    .post('/api/inventory/items')
    .set('Authorization', `Bearer ${tokens.owner}`)
    .send({ name, unit_of_measure: 'kg' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Lifecycle Org'}, ${`lc-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'lc-owner', 'owner'],
    [cashierId, 'lc-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  // An ingredient with a full history behind it: a lot, a recipe, and a sale
  // that consumed it. This is the one that must never be deletable.
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${usedId}::uuid, ${orgId}::uuid, ${'Used Flour'}, ${'kg'})`;
  const [lot] = await admin.$queryRaw<Array<{ id: string }>>`
    INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
    VALUES (${orgId}::uuid, ${usedId}::uuid, 50, 50, 130.00) RETURNING id`;
  usedLot = lot.id;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${dishId}::uuid, ${orgId}::uuid, ${'LC Dish'}, ${'LC-1'}, 40)`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${dishId}::uuid, ${usedId}::uuid, 1)`;

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Lifecycle Org B'}, ${`lc-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`lc-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${itemBId}::uuid, ${orgBId}::uuid, ${'B Ingredient'}, ${'kg'})`;
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${org}::uuid`;
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

describe('Deleting an ingredient', () => {
  test('a never-used ingredient is genuinely deleted', async () => {
    const id = await createItem('Typo Ingredient');

    const res = await request(app)
      .delete(`/api/inventory/items/${id}`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(204);

    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.raw_inventory_items WHERE id = ${id}::uuid`;
    expect(rows).toHaveLength(0);
  });

  test('one with history is refused, and the answer says what references it', async () => {
    const res = await request(app)
      .delete(`/api/inventory/items/${usedId}`)
      .set('Authorization', `Bearer ${tokens.owner}`);

    expect(res.status).toBe(409);
    expect(res.body.can_archive).toBe(true);
    // "You cannot delete this" is a dead end; the counts are what make it
    // actionable, and what justify the refusal to the person reading it.
    expect(res.body.references.stock_lots).toBe(1);
    expect(res.body.references.recipes).toBe(1);

    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.raw_inventory_items WHERE id = ${usedId}::uuid`;
    expect(rows).toHaveLength(1);
  });

  test('a cashier may not delete', async () => {
    const id = await createItem('Cashier Cannot Delete');

    const res = await request(app)
      .delete(`/api/inventory/items/${id}`)
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(res.status).toBe(403);

    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.raw_inventory_items WHERE id = ${id}::uuid`;
    expect(rows).toHaveLength(1);
  });

  test("another tenant's ingredient is 404, not 409 or 204", async () => {
    const res = await request(app)
      .delete(`/api/inventory/items/${itemBId}`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(404);

    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.raw_inventory_items WHERE id = ${itemBId}::uuid`;
    expect(rows).toHaveLength(1);
  });
});

describe('Archiving an ingredient', () => {
  test('archiving keeps the row and everything referencing it', async () => {
    const res = await request(app)
      .patch(`/api/inventory/items/${usedId}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);

    const [row] = await admin.$queryRaw<Array<{ lots: bigint; recipes: bigint }>>`
      SELECT (SELECT count(*) FROM public.inventory_batches WHERE raw_item_id = ${usedId}::uuid) AS lots,
             (SELECT count(*) FROM public.bill_of_materials WHERE raw_item_id = ${usedId}::uuid) AS recipes`;
    expect(Number(row.lots)).toBe(1);
    expect(Number(row.recipes)).toBe(1);
  });

  test('an archived ingredient still holding stock stays on the stock list', async () => {
    const res = await request(app)
      .get('/api/inventory/stock')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);

    const row = (res.body as Array<{ id: string; is_active: boolean }>).find(
      (r) => r.id === usedId,
    );
    // 50kg of it is physically on the shelf; hiding it would mean nobody could
    // sell, count or write off stock that exists.
    expect(row).toBeDefined();
    expect(row!.is_active).toBe(false);
  });

  test('an archived ingredient is never suggested for reorder', async () => {
    await admin.$executeRaw`UPDATE public.raw_inventory_items SET reorder_threshold = 999 WHERE id = ${usedId}::uuid`;

    const res = await request(app)
      .get('/api/purchase-orders/suggestions')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);

    const suggestions = (res.body.suggestions ?? res.body) as Array<{ id: string }>;
    expect(suggestions.some((s) => s.id === usedId)).toBe(false);
  });

  test('un-archiving puts it back', async () => {
    const res = await request(app)
      .patch(`/api/inventory/items/${usedId}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: true });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(true);
  });

  test('a cashier may not archive', async () => {
    const res = await request(app)
      .patch(`/api/inventory/items/${usedId}`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ is_active: false });
    expect(res.status).toBe(403);
  });

  test('is_active must be a boolean', async () => {
    const res = await request(app)
      .patch(`/api/inventory/items/${usedId}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: 'no' });
    expect(res.status).toBe(400);
  });
});

describe('Correcting a mis-keyed lot cost', () => {
  test('the lots behind an ingredient are listable', async () => {
    const res = await request(app)
      .get(`/api/inventory/items/${usedId}/batches`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(Number(res.body[0].cost_at_purchase)).toBeCloseTo(130, 6);
  });

  test('a manager corrects it, and gets both figures back', async () => {
    const res = await request(app)
      .patch(`/api/inventory/batches/${usedLot}/cost`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ cost_at_purchase: 13 });
    expect(res.status).toBe(200);
    // A correction whose before-and-after you cannot see is one you have to
    // take on trust.
    expect(res.body.previous_cost).toBeCloseTo(130, 6);
    expect(res.body.cost_at_purchase).toBeCloseTo(13, 6);

    const [row] = await admin.$queryRaw<Array<{ c: unknown }>>`
      SELECT cost_at_purchase AS c FROM public.inventory_batches WHERE id = ${usedLot}::uuid`;
    expect(Number(row.c)).toBeCloseTo(13, 6);
  });

  test('stock value follows the correction', async () => {
    const res = await request(app)
      .get('/api/inventory/stock')
      .set('Authorization', `Bearer ${tokens.owner}`);
    const row = (res.body as Array<{ id: string; stock_value: number }>).find(
      (r) => r.id === usedId,
    )!;
    expect(Number(row.stock_value)).toBeCloseTo(650, 6); // 50 x 13.00
  });

  test('recorded COGS on past sales does NOT move', async () => {
    // The property that separates a correction from a falsification. A sale is
    // recorded at the cost it was actually sold at (0015); if this ever changes,
    // every historical margin figure has quietly become editable.
    const orderId = randomUUID();
    await admin.$executeRaw`INSERT INTO public.orders (id, organization_id, client_offline_id, total_amount) VALUES (${orderId}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 40)`;
    await admin.$executeRaw`INSERT INTO public.order_items (order_id, organization_id, sellable_item_id, quantity, unit_price, cost_at_sale, cost_is_complete, fired_at) VALUES (${orderId}::uuid, ${orgId}::uuid, ${dishId}::uuid, 1, 40, 13, true, (SELECT created_at FROM public.orders WHERE id = ${orderId}::uuid))`;

    const before = await request(app)
      .get('/api/reports/profitability?days=30')
      .set('Authorization', `Bearer ${tokens.owner}`);
    const cogsBefore = before.body.summary.cogs;

    const res = await request(app)
      .patch(`/api/inventory/batches/${usedLot}/cost`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ cost_at_purchase: 999 });
    expect(res.status).toBe(200);

    const after = await request(app)
      .get('/api/reports/profitability?days=30')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(after.body.summary.cogs).toBeCloseTo(cogsBefore, 6);
  });

  test('a cashier may not correct a cost', async () => {
    const res = await request(app)
      .patch(`/api/inventory/batches/${usedLot}/cost`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ cost_at_purchase: 1 });
    expect(res.status).toBe(403);
  });

  test('the cost must be a number of zero or more', async () => {
    for (const cost of [-1, 'free', null, undefined]) {
      const res = await request(app)
        .patch(`/api/inventory/batches/${usedLot}/cost`)
        .set('Authorization', `Bearer ${tokens.owner}`)
        .send({ cost_at_purchase: cost });
      expect(res.status).toBe(400);
    }
  });

  test('an unknown lot is 404', async () => {
    const res = await request(app)
      .patch(`/api/inventory/batches/${randomUUID()}/cost`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ cost_at_purchase: 5 });
    expect(res.status).toBe(404);
  });
});

describe('Recording what the delivery cost (0025)', () => {
  async function receive(body: Record<string, unknown>) {
    return request(app)
      .post('/api/inventory/receive')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ raw_item_id: usedId, quantity_received: 8000, ...body });
  }

  test('an invoice total is stored, and the rate keeps its precision', async () => {
    // The reported case: 250.00 for 8000 g. At numeric(10,2) the rate rounded
    // to 0.03 and the lot valued at 240.00 — 10.00 of real money gone.
    const res = await receive({ total_cost: 250 });
    expect(res.status).toBe(201);

    const [lot] = await admin.$queryRaw<Array<{ rate: unknown; bill: unknown }>>`
      SELECT cost_at_purchase AS rate, total_cost AS bill
      FROM public.inventory_batches
      WHERE raw_item_id = ${usedId}::uuid ORDER BY received_at DESC LIMIT 1`;

    expect(Number(lot.rate)).toBeCloseTo(0.03125, 6);
    expect(Number(lot.bill)).toBeCloseTo(250, 2);
    // The whole point: the lot reconciles to the invoice.
    expect(Number(lot.rate) * 8000).toBeCloseTo(250, 2);
  });

  test('a per-unit rate still works, and the bill is derived from it', async () => {
    const res = await receive({ cost_at_purchase: 0.05 });
    expect(res.status).toBe(201);

    const [lot] = await admin.$queryRaw<Array<{ rate: unknown; bill: unknown }>>`
      SELECT cost_at_purchase AS rate, total_cost AS bill
      FROM public.inventory_batches
      WHERE raw_item_id = ${usedId}::uuid ORDER BY received_at DESC LIMIT 1`;
    expect(Number(lot.rate)).toBeCloseTo(0.05, 6);
    expect(Number(lot.bill)).toBeCloseTo(400, 2); // 8000 x 0.05
  });

  test('exactly one of the two figures must be given', async () => {
    // Both is ambiguous — which one wins? Neither leaves the lot uncosted.
    expect((await receive({ cost_at_purchase: 1, total_cost: 8000 })).status).toBe(400);
    expect((await receive({})).status).toBe(400);
  });

  test('neither figure may be negative', async () => {
    expect((await receive({ total_cost: -1 })).status).toBe(400);
    expect((await receive({ cost_at_purchase: -1 })).status).toBe(400);
  });

  test('the lots view shows the bill next to what the lot implies', async () => {
    const res = await request(app)
      .get(`/api/inventory/items/${usedId}/batches`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);

    const lot = (res.body as Array<{ total_cost: number; implied_total: number }>).find(
      (l) => Number(l.total_cost) === 400,
    )!;
    expect(lot).toBeDefined();
    // Both are shown so a reconciliation can see any rounding gap rather than
    // having it smoothed away.
    expect(Number(lot.implied_total)).toBeCloseTo(400, 2);
  });
});
