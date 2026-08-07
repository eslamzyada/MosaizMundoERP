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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the inventory asset tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const movingId = randomUUID(); // holds stock AND gets used
const stuckId = randomUUID(); // holds stock, never moves — the dead capital
const tokens: Record<string, string> = {};
let movingLot: string;

interface AssetRow {
  id: string;
  name: string;
  capital: number;
  capital_share_pct: number | null;
  days_held: number | null;
  consumed_quantity: number;
  days_of_cover: number | null;
  is_dead_stock: boolean;
}

async function assets(who: string, query = 'days=30') {
  return request(app)
    .get(`/api/reports/inventory-assets?${query}`)
    .set('Authorization', `Bearer ${tokens[who]}`);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Assets Org'}, ${`ast-${orgId.slice(0, 8)}`}, 'enterprise')`;
  for (const [id, label, role] of [
    [ownerId, 'ast-owner', 'owner'],
    [cashierId, 'ast-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${movingId}::uuid, ${orgId}::uuid, ${'Moving Chicken'}, ${'g'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${stuckId}::uuid, ${orgId}::uuid, ${'Stuck Saffron'}, ${'g'})`;

  // 1000 g @0.50 = 500.00, received 40 days ago so the age is real.
  const old = new Date();
  old.setDate(old.getDate() - 40);
  const [lot] = await admin.$queryRaw<Array<{ id: string }>>`
    INSERT INTO public.inventory_batches
      (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, received_at)
    VALUES (${orgId}::uuid, ${movingId}::uuid, 1000, 1000, 0.50, ${old}) RETURNING id`;
  movingLot = lot.id;

  // 100 g @2.00 = 200.00, and nothing will ever consume it.
  await admin.$executeRaw`
    INSERT INTO public.inventory_batches
      (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, received_at)
    VALUES (${orgId}::uuid, ${stuckId}::uuid, 100, 100, 2.00, ${old})`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.inventory_consumption WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  // Write-off lines point at the batches, so they go first. The app role has no
  // DELETE here at all (0023 — a write-off is a permanent record); only the
  // superuser this harness seeds with can unpick a fixture.
  await admin.$executeRaw`DELETE FROM public.stock_write_off_lines WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.stock_write_offs WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_deficits WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Inventory as an asset — before anything has moved', () => {
  test('capital tied up is reported per ingredient, ranked', async () => {
    const res = await assets('owner');
    expect(res.status).toBe(200);

    const items = res.body.by_item as AssetRow[];
    expect(res.body.summary.capital_tied_up).toBeCloseTo(700, 2); // 500 + 200
    // Largest holding first, so the list reads as a priority order.
    expect(items[0].name).toBe('Moving Chicken');
    expect(items[0].capital).toBeCloseTo(500, 2);
    expect(items[0].capital_share_pct).toBeCloseTo(71.4, 1);
  });

  test('age of the oldest lot is reported — how long the money has been stuck', async () => {
    const res = await assets('owner');
    const chicken = (res.body.by_item as AssetRow[]).find((i) => i.name === 'Moving Chicken')!;
    expect(chicken.days_held).toBeGreaterThanOrEqual(39);
  });

  test('with NO usage recorded, nothing is called dead stock', async () => {
    // The failure this guards: dividing by zero consumption marks every
    // ingredient as dead with infinite cover, which reads as "the kitchen is
    // idle" when it actually means "no sales have been recorded yet".
    const res = await assets('owner');
    const s = res.body.summary;

    expect(s.has_usage_data).toBe(false);
    expect(s.turnover).toBeNull();
    expect(s.dead_capital).toBeCloseTo(0, 2);
    expect(s.dead_capital_pct).toBeNull();

    for (const item of res.body.by_item as AssetRow[]) {
      expect(item.is_dead_stock).toBe(false);
      // Not Infinity: a figure that cannot be compared or sorted is worse
      // than an honest gap.
      expect(item.days_of_cover).toBeNull();
    }
  });
});

describe('Inventory as an asset — once stock starts moving', () => {
  beforeAll(async () => {
    // 300 g of chicken consumed over the window, at the lot's own rate.
    const orderId = randomUUID();
    await admin.$executeRaw`INSERT INTO public.orders (id, organization_id, client_offline_id, total_amount) VALUES (${orderId}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 100)`;
    await admin.$executeRaw`
      INSERT INTO public.inventory_consumption
        (organization_id, order_id, raw_item_id, batch_id, quantity, unit_cost)
      VALUES (${orgId}::uuid, ${orderId}::uuid, ${movingId}::uuid, ${movingLot}::uuid, 300, 0.50)`;
    await admin.$executeRaw`
      UPDATE public.inventory_batches SET quantity_remaining = quantity_remaining - 300
      WHERE id = ${movingLot}::uuid`;
  });

  test('turnover is measured against what actually left the shelf', async () => {
    const res = await assets('owner');
    const s = res.body.summary;

    expect(s.has_usage_data).toBe(true);
    // 300 x 0.50 = 150.00 consumed.
    expect(s.stock_consumed_cost).toBeCloseTo(150, 2);
    // Capital is now 350 (chicken) + 200 (saffron) = 550; 150/550 = 0.27.
    expect(s.capital_tied_up).toBeCloseTo(550, 2);
    expect(s.turnover).toBeCloseTo(0.27, 2);
  });

  test('days of cover says how long the shelf lasts at the observed rate', async () => {
    const res = await assets('owner', 'days=30');
    const chicken = (res.body.by_item as AssetRow[]).find((i) => i.name === 'Moving Chicken')!;
    // 300 g over 30 days = 10 g/day; 700 g left = 70 days of cover.
    expect(chicken.days_of_cover).toBeCloseTo(70, 0);
    expect(chicken.is_dead_stock).toBe(false);
  });

  test('an ingredient that did not move at all is now flagged, and costed', async () => {
    const res = await assets('owner');
    const saffron = (res.body.by_item as AssetRow[]).find((i) => i.name === 'Stuck Saffron')!;

    expect(saffron.is_dead_stock).toBe(true);
    expect(saffron.days_of_cover).toBeNull();
    expect(res.body.summary.dead_capital).toBeCloseTo(200, 2);
    // 200 of 550 is money sitting still while the rest works.
    expect(res.body.summary.dead_capital_pct).toBeCloseTo(36.4, 1);
  });

  test('a write-off counts as movement — the wrong kind, but movement', async () => {
    // Counting only sales would report a heavily-wasted ingredient as
    // slow-moving, when it is moving fast in the wrong direction.
    const before = await assets('owner');
    const beforeCost = before.body.summary.stock_consumed_cost;

    const res = await request(app)
      .post('/api/inventory/write-offs')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ raw_item_id: stuckId, quantity: 10, reason: 'expired' });
    expect(res.status).toBe(201);

    const after = await assets('owner');
    expect(after.body.summary.stock_consumed_cost).toBeCloseTo(beforeCost + 20, 2); // 10 x 2.00
    const saffron = (after.body.by_item as AssetRow[]).find((i) => i.name === 'Stuck Saffron')!;
    expect(saffron.is_dead_stock).toBe(false);
  });
});

describe('Inventory asset report access', () => {
  test('it honours an explicit date range', async () => {
    const day = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      const p = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const res = await assets('owner', `from=${day(-7)}&to=${day(0)}`);
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(day(-7));
    expect(res.body.days).toBeNull();
  });

  test('a bad range is refused', async () => {
    expect((await assets('owner', 'from=nonsense&to=2026-01-01')).status).toBe(400);
  });

  test('a cashier may not read what the business is worth', async () => {
    expect((await assets('cashier')).status).toBe(403);
  });
});
