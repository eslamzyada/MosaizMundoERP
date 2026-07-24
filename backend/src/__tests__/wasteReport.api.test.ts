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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the waste report tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const supplierId = randomUUID();
const beefId = randomUUID(); // written off repeatedly, from a known supplier
const herbId = randomUUID(); // written off once, no supplier on the lot
const dishId = randomUUID(); // sold, to give the report a COGS denominator

const tokens: Record<string, string> = {};

interface ReasonRow {
  reason: string;
  is_waste: boolean;
  write_off_count: number;
  quantity: number;
  cost: number;
  exceeded_recorded_stock_count: number;
}

async function waste(who: string, days = 30) {
  return request(app)
    .get(`/api/reports/waste?days=${days}`)
    .set('Authorization', `Bearer ${tokens[who]}`);
}

async function writeOff(rawId: string, quantity: number, reason: string, note?: string) {
  const res = await request(app)
    .post('/api/inventory/write-offs')
    .set('Authorization', `Bearer ${tokens.owner}`)
    .send({ raw_item_id: rawId, quantity, reason, ...(note ? { note } : {}) });
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Waste Org'}, ${`waste-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'waste-owner', 'owner'],
    [cashierId, 'waste-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${supplierId}::uuid, ${orgId}::uuid, ${'Careless Meats'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${beefId}::uuid, ${orgId}::uuid, ${'Waste Beef'}, ${'kg'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${herbId}::uuid, ${orgId}::uuid, ${'Waste Herbs'}, ${'kg'})`;

  // Beef: 100 @10.00, attributed to a supplier. Herbs: 100 @1.00, no supplier.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, supplier_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${beefId}::uuid, ${supplierId}::uuid, 100, 100, 10.00)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${herbId}::uuid, 100, 100, 1.00)`;

  // A dish that has actually sold, so the report has a COGS denominator: 100.00
  // of food cost against which waste can be expressed as a share.
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${dishId}::uuid, ${orgId}::uuid, ${'Waste Dish'}, ${'WASTE-1'}, 50)`;
  const orderId = randomUUID();
  await admin.$executeRaw`INSERT INTO public.orders (id, organization_id, client_offline_id, total_amount) VALUES (${orderId}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 200)`;
  await admin.$executeRaw`INSERT INTO public.order_items (order_id, organization_id, sellable_item_id, quantity, unit_price, cost_at_sale, cost_is_complete) VALUES (${orderId}::uuid, ${orgId}::uuid, ${dishId}::uuid, 4, 50, 100, true)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.stock_write_off_lines WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.stock_write_offs WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_deficits WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Waste report', () => {
  beforeAll(async () => {
    // 3kg beef spoiled (30.00) and 2kg expired (20.00) -> 50.00 of real waste,
    // all of it the supplier's stock.
    await writeOff(beefId, 3, 'spoiled', 'walk-in failed');
    await writeOff(beefId, 2, 'expired');
    // 10kg herbs binned in a prep error -> 10.00. Total waste 60.00.
    await writeOff(herbId, 10, 'prep_error');
    // A staff meal (5.00) and an 'other' (2.00): real cost, NOT waste.
    await writeOff(herbId, 5, 'staff_meal');
    await writeOff(herbId, 2, 'other', 'donated to the shelter');
  });

  test('waste totals only the causes that destroyed food', async () => {
    const res = await waste('owner');
    expect(res.status).toBe(200);

    const s = res.body.summary;
    expect(s.waste_cost).toBeCloseTo(60, 6); // 30 + 20 + 10
    expect(s.staff_meal_cost).toBeCloseTo(5, 6);
    expect(s.other_cost).toBeCloseTo(2, 6);
    // Everything discarded is reported too — the split is the point, not a filter.
    expect(s.write_off_cost).toBeCloseTo(67, 6);
    expect(s.write_off_count).toBe(5);
  });

  test('a staff meal is never counted as waste', async () => {
    const res = await waste('owner');
    const rows = res.body.by_reason as ReasonRow[];

    const staff = rows.find((r) => r.reason === 'staff_meal')!;
    expect(staff.is_waste).toBe(false);
    expect(staff.cost).toBeCloseTo(5, 6);

    const other = rows.find((r) => r.reason === 'other')!;
    expect(other.is_waste).toBe(false);

    // And the four real causes are marked as waste.
    for (const reason of ['spoiled', 'expired', 'prep_error']) {
      const row = rows.find((r) => r.reason === reason);
      if (row) expect(row.is_waste).toBe(true);
    }
  });

  test('waste is expressed against total food cost, not in a vacuum', async () => {
    const res = await waste('owner');
    const s = res.body.summary;

    // 100.00 of food actually sold, 60.00 wasted -> 60/(60+100) = 37.5%.
    expect(s.cogs).toBeCloseTo(100, 6);
    expect(s.waste_share_pct).toBeCloseTo(37.5, 1);
  });

  test('the ingredient breakdown ranks by what it cost, and excludes staff meals', async () => {
    const res = await waste('owner');
    const items = res.body.by_item as Array<{ name: string; cost: number; quantity: number }>;

    const beef = items.find((i) => i.name === 'Waste Beef')!;
    const herbs = items.find((i) => i.name === 'Waste Herbs')!;
    expect(beef.cost).toBeCloseTo(50, 6);
    expect(beef.quantity).toBeCloseTo(5, 6);
    // Herbs: only the 10kg prep error, NOT the staff meal or the 'other'.
    expect(herbs.cost).toBeCloseTo(10, 6);
    expect(herbs.quantity).toBeCloseTo(10, 6);
    // Costliest first, so the list reads as a priority order.
    expect(items[0].name).toBe('Waste Beef');
  });

  test("the supplier breakdown answers 'whose stock keeps spoiling'", async () => {
    const res = await waste('owner');
    const suppliers = res.body.by_supplier as Array<{ name: string; cost: number }>;

    expect(suppliers).toHaveLength(1);
    expect(suppliers[0].name).toBe('Careless Meats');
    expect(suppliers[0].cost).toBeCloseTo(50, 6);
    // The herb lot had no supplier, so it contributes nothing here rather than
    // appearing under a null name.
  });

  test('the window filters by date', async () => {
    await admin.$executeRaw`
      UPDATE public.stock_write_offs SET created_at = now() - interval '60 days'
      WHERE organization_id = ${orgId}::uuid AND reason = 'expired'`;

    const near = await waste('owner', 30);
    expect(near.body.summary.waste_cost).toBeCloseTo(40, 6); // the 20.00 drops out

    const far = await waste('owner', 90);
    expect(far.body.summary.waste_cost).toBeCloseTo(60, 6);

    await admin.$executeRaw`
      UPDATE public.stock_write_offs SET created_at = now()
      WHERE organization_id = ${orgId}::uuid AND reason = 'expired'`;
  });

  test('a write-off that exceeded recorded stock is flagged', async () => {
    // Herbs are down to 73kg; bin 100. The books were short by 27.
    await writeOff(herbId, 100, 'spoiled');

    const res = await waste('owner');
    expect(res.body.summary.exceeded_recorded_stock_count).toBeGreaterThan(0);
  });

  test('a cashier may not read what waste costs', async () => {
    const res = await waste('cashier');
    expect(res.status).toBe(403);
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/reports/waste');
    expect(res.status).toBe(401);
  });
});
