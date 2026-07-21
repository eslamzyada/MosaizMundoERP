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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the inventory tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

// Tenant A (the caller) and a raw item + a seeded deficit in its org.
const userId = randomUUID();
const orgId = randomUUID();
const rawItemId = randomUUID();

// Tenant B: a raw item the caller must NOT be able to receive stock into.
const orgBId = randomUUID();
const userBId = randomUUID();
const rawItemBId = randomUUID();

// A cashier in Tenant A — may read, may NOT manage ingredients.
const cashierId = randomUUID();

let token: string;
let cashierToken: string;

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`inv-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Inv Org A'}, ${`inv-a-${userId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${rawItemId}::uuid, ${orgId}::uuid, ${'Flour'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.inventory_deficits (organization_id, raw_item_id, missing_quantity) VALUES (${orgId}::uuid, ${rawItemId}::uuid, 5)`;

  // Tenant B + a raw item owned by B.
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`inv-b-${userBId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Inv Org B'}, ${`inv-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${rawItemBId}::uuid, ${orgBId}::uuid, ${'Sugar'}, ${'grams'})`;

  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${cashierId}::uuid, ${`inv-cashier-${cashierId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${cashierId}::uuid, 'cashier')`;

  token = jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
  cashierToken = jwt.sign(
    { sub: cashierId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_deficits WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.stocktakes WHERE organization_id = ${org}::uuid`; // cascades stocktake_items
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${userId}::uuid, ${userBId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Inventory API', () => {
  test('GET /api/inventory/deficits returns 200 with the ingredient name', async () => {
    const res = await request(app)
      .get('/api/inventory/deficits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const mine = res.body.find(
      (d: { raw_item_id: string }) => d.raw_item_id === rawItemId,
    );
    expect(mine).toBeDefined();
    expect(mine.raw_inventory_items.name).toBe('Flour');
    // Decimal serialization fix: missing_quantity is a JSON number.
    expect(typeof mine.missing_quantity).toBe('number');
    expect(mine.missing_quantity).toBe(5);
    // RLS-scoped: nothing from Tenant B is visible.
    expect(
      res.body.every((d: { organization_id: string }) => d.organization_id === orgId),
    ).toBe(true);
  });

  test('POST /api/inventory/receive creates a batch (201) with remaining == received', async () => {
    const res = await request(app)
      .post('/api/inventory/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({ raw_item_id: rawItemId, quantity_received: 25, cost_at_purchase: 3.5 });

    expect(res.status).toBe(201);
    expect(res.body.organization_id).toBe(orgId);
    // Decimal serialization fix: quantities come back as JSON numbers.
    expect(typeof res.body.quantity_received).toBe('number');
    expect(res.body.quantity_received).toBe(25);
    expect(typeof res.body.quantity_remaining).toBe('number');
    expect(res.body.quantity_remaining).toBe(25);
  });

  test('POST /api/inventory/receive into another tenant is blocked (404)', async () => {
    // Tenant A tries to receive stock against Tenant B's raw item. RLS hides
    // that item, so the org cannot be derived -> 404, no stock injected.
    const res = await request(app)
      .post('/api/inventory/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({ raw_item_id: rawItemBId, quantity_received: 10, cost_at_purchase: 1.0 });

    expect(res.status).toBe(404);
  });

  test('POST /api/inventory/stocktakes/:id/post makes the books match the count (0019)', async () => {
    const onHand = async (): Promise<number> => {
      const [row] = await admin.$queryRaw<Array<{ q: unknown }>>`
        SELECT COALESCE(sum(quantity_remaining), 0) AS q FROM public.inventory_batches
        WHERE raw_item_id = ${rawItemId}::uuid AND organization_id = ${orgId}::uuid`;
      return Number(row.q);
    };
    const before = await onHand();
    expect(before).toBeGreaterThan(2); // enough stock to absorb the shortfall

    // A draft with a -2 variance on the Flour raw item, which also carries the
    // deficit of 5 seeded in beforeAll.
    const stocktakeId = randomUUID();
    await admin.$executeRaw`INSERT INTO public.stocktakes (id, organization_id, status) VALUES (${stocktakeId}::uuid, ${orgId}::uuid, 'draft')`;
    await admin.$executeRaw`INSERT INTO public.stocktake_items (stocktake_id, organization_id, raw_item_id, expected_quantity, counted_quantity) VALUES (${stocktakeId}::uuid, ${orgId}::uuid, ${rawItemId}::uuid, 10, 8)`;

    const res = await request(app)
      .post(`/api/inventory/stocktakes/${stocktakeId}/post`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const status = await admin.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM public.stocktakes WHERE id = ${stocktakeId}::uuid`;
    expect(status[0].status).toBe('posted');

    // The shortfall moves real stock now: before 0019 the lots were left alone
    // and the system went on reporting inventory that was not on the shelf.
    expect(await onHand()).toBeCloseTo(before - 2, 6);

    // And the count settles the item: the deficit of 5 was "awaiting
    // reconciliation", the count IS that reconciliation, and the shortfall was
    // absorbed by real lots — so nothing outstanding remains.
    const deficit = await admin.$queryRaw<Array<{ missing_quantity: unknown }>>`
      SELECT missing_quantity FROM public.inventory_deficits
      WHERE raw_item_id = ${rawItemId}::uuid AND organization_id = ${orgId}::uuid`;
    expect(deficit).toHaveLength(0);

    // Posting an already-posted stocktake is rejected (400).
    const again = await request(app)
      .post(`/api/inventory/stocktakes/${stocktakeId}/post`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(400);
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/inventory/deficits');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/inventory/stock', () => {
  // A dedicated ingredient, so these aggregate assertions are immune to what
  // the receive/stocktake tests above do to the Flour item.
  const oilId = randomUUID();

  beforeAll(async () => {
    await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure, reorder_threshold) VALUES (${oilId}::uuid, ${orgId}::uuid, ${'Olive Oil'}, ${'ml'}, 500)`;
    // Two open lots and one fully drained lot. The drained lot is the trap: it
    // has the soonest expiry, so it must be excluded from BOTH the totals and
    // the earliest-expiry calculation.
    await admin.$executeRaw`
      INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date)
      VALUES
        (${orgId}::uuid, ${oilId}::uuid, 100, 100, 2.00, now() + interval '30 days'),
        (${orgId}::uuid, ${oilId}::uuid, 100,  40, 3.00, now() + interval '5 days'),
        (${orgId}::uuid, ${oilId}::uuid,  50,   0, 1.00, now() + interval '1 day')`;
  });

  test('aggregates open lots per ingredient and ignores drained ones', async () => {
    const res = await request(app)
      .get('/api/inventory/stock')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const row = res.body.find((r: { id: string }) => r.id === oilId);
    expect(row).toBeDefined();
    expect(row.name).toBe('Olive Oil');
    expect(row.unit_of_measure).toBe('ml');

    // 100 + 40 — the drained lot contributes nothing.
    expect(typeof row.on_hand).toBe('number');
    expect(row.on_hand).toBe(140);
    expect(row.open_batches).toBe(2);
    // Value follows remaining quantity at each lot's own cost: 100*2 + 40*3.
    expect(row.stock_value).toBe(320);
    expect(row.reorder_threshold).toBe(500);

    // Soonest expiry among OPEN lots is the 5-day one — NOT the drained 1-day lot.
    const expiry = new Date(row.earliest_expiry).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(expiry).toBeGreaterThan(Date.now() + 4 * day);
    expect(expiry).toBeLessThan(Date.now() + 6 * day);
  });

  test('an ingredient with no open lots still appears, at zero', async () => {
    const emptyId = randomUUID();
    await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${emptyId}::uuid, ${orgId}::uuid, ${'Zaatar'}, ${'grams'})`;

    const res = await request(app)
      .get('/api/inventory/stock')
      .set('Authorization', `Bearer ${token}`);

    const row = res.body.find((r: { id: string }) => r.id === emptyId);
    expect(row).toBeDefined();
    expect(row.on_hand).toBe(0);
    expect(row.open_batches).toBe(0);
    expect(row.stock_value).toBe(0);
    expect(row.earliest_expiry).toBeNull();
    // Backfilled default from migration 0009.
    expect(row.reorder_threshold).toBe(0);
  });

  test('is RLS-scoped: another tenant\'s ingredient never appears', async () => {
    const res = await request(app)
      .get('/api/inventory/stock')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.some((r: { id: string }) => r.id === rawItemBId)).toBe(false);
    expect(res.body.some((r: { name: string }) => r.name === 'Sugar')).toBe(false);
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/inventory/stock');
    expect(res.status).toBe(401);
  });
});

describe('Ingredient management (create / update, admin-only)', () => {
  let createdId: string;

  test('owner creates an ingredient (201) with name, unit, and reorder threshold', async () => {
    const res = await request(app)
      .post('/api/inventory/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Chickpeas', unit_of_measure: 'grams', reorder_threshold: 500 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Chickpeas');
    expect(res.body.organization_id).toBe(orgId);
    expect(Number(res.body.reorder_threshold)).toBe(500);
    createdId = res.body.id;
  });

  test('the new ingredient appears in /items and in /stock at zero on-hand', async () => {
    const items = await request(app)
      .get('/api/inventory/items')
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(items.status).toBe(200);
    expect(items.body.some((i: { id: string }) => i.id === createdId)).toBe(true);

    const stock = await request(app)
      .get('/api/inventory/stock')
      .set('Authorization', `Bearer ${token}`);
    const row = stock.body.find((s: { id: string }) => s.id === createdId);
    expect(row).toBeDefined();
    expect(row.on_hand).toBe(0);
    expect(row.reorder_threshold).toBe(500);
  });

  test('owner updates the ingredient (rename + new threshold) (200)', async () => {
    const res = await request(app)
      .patch(`/api/inventory/items/${createdId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Chick Peas', reorder_threshold: 750 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Chick Peas');
    expect(Number(res.body.reorder_threshold)).toBe(750);
  });

  test('a duplicate ingredient name is rejected (409)', async () => {
    const res = await request(app)
      .post('/api/inventory/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Flour', unit_of_measure: 'grams' }); // Flour already exists in org A
    expect(res.status).toBe(409);
  });

  test('a cashier cannot create an ingredient (403), and nothing is written', async () => {
    const before = await admin.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
    const res = await request(app)
      .post('/api/inventory/items')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ name: 'Sneaky Ingredient', unit_of_measure: 'grams' });
    expect(res.status).toBe(403);
    const after = await admin.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  test('a cashier cannot update an ingredient (403)', async () => {
    const res = await request(app)
      .patch(`/api/inventory/items/${createdId}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ reorder_threshold: 0 });
    expect(res.status).toBe(403);
  });

  test('validation: missing unit (400) and negative threshold (400)', async () => {
    const noUnit = await request(app)
      .post('/api/inventory/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No Unit' });
    expect(noUnit.status).toBe(400);

    const negThreshold = await request(app)
      .post('/api/inventory/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Neg', unit_of_measure: 'grams', reorder_threshold: -1 });
    expect(negThreshold.status).toBe(400);
  });

  test("cannot update another tenant's ingredient (404), and it is unchanged", async () => {
    const res = await request(app)
      .patch(`/api/inventory/items/${rawItemBId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);

    const rows = await admin.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM public.raw_inventory_items WHERE id = ${rawItemBId}::uuid`;
    expect(rows[0].name).toBe('Sugar');
  });
});
