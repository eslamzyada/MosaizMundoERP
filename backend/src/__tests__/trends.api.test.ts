import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Sales, waste and buying on one timeline.
 *
 * The assertion that matters most here is the boring-sounding one: **a day when
 * nothing happened still has a point**. A GROUP BY only emits rows for days
 * something occurred, and a chart fed those rows draws a line straight from
 * Sunday to Tuesday as though Monday never existed. The timeline silently
 * compresses; a quiet week looks like a short busy one. Nothing about the
 * resulting picture looks broken, which is why it needs a test rather than a
 * glance.
 *
 * The second is that the series LINE UP. Waste recorded on a day with no sales
 * has to land on that day — an inner join, or four separate endpoints each
 * rounding the window their own way, puts the waste line a day out from the
 * revenue line and nobody can tell by looking.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the trends tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();
const accountantId = randomUUID();

const itemId = randomUUID();
const ingredientId = randomUUID();
const supplierId = randomUUID();
const foreignItemId = randomUUID();
const foreignIngredientId = randomUUID();
const foreignSupplierId = randomUUID();

let managerToken = '';
let cashierToken = '';
let accountantToken = '';

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asCashier = () => ({ Authorization: `Bearer ${cashierToken}` });
const asAccountant = () => ({ Authorization: `Bearer ${accountantToken}` });

interface Point {
  bucket_start: string;
  revenue: number;
  costed_revenue: number;
  cogs: number;
  gross_profit: number;
  order_count: number;
  waste_cost: number;
  write_off_cost: number;
  purchasing_cost: number;
}

/**
 * The calendar date N days before today, in the SAME local zone Postgres
 * buckets by. Built from year/month/day rather than by subtracting
 * milliseconds, so a daylight-saving boundary inside the window cannot shift it.
 */
function dayAgo(n: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Mid-afternoon N days ago — far from midnight in any zone, so the bucket is unambiguous. */
const at = (n: number) => `date_trunc('day', now()) - interval '${n} days' + interval '14 hours'`;

async function seedOrder(opts: {
  org: string;
  item: string;
  daysAgo: number;
  status: 'completed' | 'voided';
  quantity: number;
  unitPrice: number;
  cost: number;
}) {
  const orderId = randomUUID();
  const voided = opts.status === 'voided';
  await admin.$executeRawUnsafe(
    `INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount, created_at, void_reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, ${at(opts.daysAgo)}, $6)`,
    orderId,
    opts.org,
    randomUUID(),
    opts.status,
    opts.quantity * opts.unitPrice,
    voided ? 'test_order' : null,
  );
  // fired_at is required before a line may carry a cost (0029) — an unfired
  // line is one the kitchen never started, and it has no cost yet.
  await admin.$executeRawUnsafe(
    `INSERT INTO public.order_items
       (order_id, organization_id, sellable_item_id, quantity, unit_price, cost_at_sale, cost_is_complete, fired_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, true, ${at(opts.daysAgo)})`,
    orderId,
    opts.org,
    opts.item,
    opts.quantity,
    opts.unitPrice,
    opts.cost,
  );
  return orderId;
}

async function seedWriteOff(opts: {
  org: string;
  item: string;
  daysAgo: number;
  reason: string;
  cost: number;
}) {
  await admin.$executeRawUnsafe(
    `INSERT INTO public.stock_write_offs
       (organization_id, raw_item_id, quantity_requested, quantity_written_off, total_cost, reason, created_at)
     VALUES ($1::uuid, $2::uuid, 1, 1, $3, $4, ${at(opts.daysAgo)})`,
    opts.org,
    opts.item,
    opts.cost,
    opts.reason,
  );
}

async function seedPurchaseOrder(opts: {
  org: string;
  supplier: string;
  item: string;
  status: string;
  placedDaysAgo: number | null;
  createdDaysAgo: number;
  ordered: number;
  received: number;
  unitPrice: number;
}) {
  const poId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO public.purchase_orders (id, organization_id, supplier_id, status, created_at, placed_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ${at(opts.createdDaysAgo)},
             ${opts.placedDaysAgo === null ? 'NULL' : at(opts.placedDaysAgo)})`,
    poId,
    opts.org,
    opts.supplier,
    opts.status,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO public.purchase_order_lines
       (purchase_order_id, organization_id, raw_item_id, quantity_ordered, quantity_received, unit_price)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
    poId,
    opts.org,
    opts.item,
    opts.ordered,
    opts.received,
    opts.unitPrice,
  );
  return poId;
}

beforeAll(async () => {
  for (const [id, label] of [
    [orgId, 'Trends Org'],
    [otherOrgId, 'Other Trends Org'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${label}, ${`trend-${id.slice(0, 8)}`}, 'basic')`;
  }

  for (const [id, prefix, role] of [
    [managerId, 'trd-mgr', 'branch_manager'],
    [cashierId, 'trd-csh', 'cashier'],
    [accountantId, 'trd-acc', 'accountant'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  managerToken = sign(managerId);
  cashierToken = sign(cashierId);
  accountantToken = sign(accountantId);

  for (const [org, item, ingredient, supplier] of [
    [orgId, itemId, ingredientId, supplierId],
    [otherOrgId, foreignItemId, foreignIngredientId, foreignSupplierId],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${item}::uuid, ${org}::uuid, ${'طبق اختبار'}, 50.00)`;
    await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${ingredient}::uuid, ${org}::uuid, ${'مكوّن اختبار'}, 'kg')`;
    await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${supplier}::uuid, ${org}::uuid, ${'مورّد اختبار'})`;
  }

  // --- our restaurant -----------------------------------------------------
  // Day 1: two sales. Day 3: one sale, plus a void that must not count.
  // Day 2: NO sales at all — the gap the whole spine exists for.
  await seedOrder({ org: orgId, item: itemId, daysAgo: 1, status: 'completed', quantity: 2, unitPrice: 50, cost: 40 });
  await seedOrder({ org: orgId, item: itemId, daysAgo: 1, status: 'completed', quantity: 1, unitPrice: 50, cost: 20 });
  await seedOrder({ org: orgId, item: itemId, daysAgo: 3, status: 'completed', quantity: 1, unitPrice: 50, cost: 20 });
  await seedOrder({ org: orgId, item: itemId, daysAgo: 3, status: 'voided', quantity: 20, unitPrice: 50, cost: 400 });

  // Waste on the SILENT day, so the point has to exist for it to land on.
  await seedWriteOff({ org: orgId, item: ingredientId, daysAgo: 2, reason: 'expired', cost: 30 });
  // A staff meal is a real cost but not waste — it must split.
  await seedWriteOff({ org: orgId, item: ingredientId, daysAgo: 1, reason: 'staff_meal', cost: 7 });

  // Placed two days ago: 10 @ 5 = 50 committed, 4 received = 20, 30 outstanding.
  await seedPurchaseOrder({ org: orgId, supplier: supplierId, item: ingredientId, status: 'placed', placedDaysAgo: 2, createdDaysAgo: 2, ordered: 10, received: 4, unitPrice: 5 });
  // Written five days ago, PLACED yesterday: it is yesterday's spending.
  await seedPurchaseOrder({ org: orgId, supplier: supplierId, item: ingredientId, status: 'received', placedDaysAgo: 1, createdDaysAgo: 5, ordered: 2, received: 2, unitPrice: 11 });
  // Never placed, and cancelled — neither is a commitment.
  await seedPurchaseOrder({ org: orgId, supplier: supplierId, item: ingredientId, status: 'draft', placedDaysAgo: null, createdDaysAgo: 2, ordered: 100, received: 0, unitPrice: 9 });
  await seedPurchaseOrder({ org: orgId, supplier: supplierId, item: ingredientId, status: 'cancelled', placedDaysAgo: 3, createdDaysAgo: 3, ordered: 200, received: 0, unitPrice: 9 });

  // --- somebody else's restaurant, same window, loud numbers --------------
  await seedOrder({ org: otherOrgId, item: foreignItemId, daysAgo: 1, status: 'completed', quantity: 100, unitPrice: 50, cost: 1000 });
  await seedWriteOff({ org: otherOrgId, item: foreignIngredientId, daysAgo: 2, reason: 'expired', cost: 5000 });
  await seedPurchaseOrder({ org: otherOrgId, supplier: foreignSupplierId, item: foreignIngredientId, status: 'placed', placedDaysAgo: 2, createdDaysAgo: 2, ordered: 500, received: 0, unitPrice: 9 });
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.stock_write_offs WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.purchase_order_lines WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.purchase_orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid, ${accountantId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

async function trends(query = 'days=7', headers = asManager()) {
  const res = await request(app).get(`/api/reports/trends?${query}`).set(headers);
  expect(res.status).toBe(200);
  return res.body as { points: Point[]; summary: Record<string, number | null>; bucket: string };
}

const pointOn = (points: Point[], day: string) =>
  points.find((p) => p.bucket_start === day) as Point;

describe('the spine of days', () => {
  it('returns one point per day in the window, not one per day with data', async () => {
    const { points } = await trends('days=7');
    // Seven days requested, seven points — regardless of how many of them the
    // restaurant actually traded on.
    expect(points).toHaveLength(7);
  });

  it('THE ONE THAT MATTERS: a day with nothing on it is still a day', async () => {
    const { points } = await trends('days=7');
    const silent = pointOn(points, dayAgo(2));

    // It exists...
    expect(silent).toBeDefined();
    // ...and it is a real zero, not a missing row.
    expect(silent.revenue).toBe(0);
    expect(silent.order_count).toBe(0);
  });

  it('keeps the series aligned: waste lands on the silent day', async () => {
    // The point of the LEFT JOINs. An inner join drops this bucket entirely
    // because nothing sold, and 30 ج.م of waste disappears from the chart.
    const { points } = await trends('days=7');
    const silent = pointOn(points, dayAgo(2));

    expect(silent.waste_cost).toBe(30);
    expect(silent.revenue).toBe(0);
  });

  it('runs in order, oldest first', async () => {
    const { points } = await trends('days=7');
    const days = points.map((p) => p.bucket_start);
    expect([...days].sort()).toEqual(days);
  });

  it('labels a bucket with its LOCAL calendar day', async () => {
    // toISOString() on a local midnight is the previous day anywhere east of
    // UTC — every bucket would be labelled a day early, consistently enough
    // that it would never look wrong.
    const { points } = await trends('days=7');
    expect(points.map((p) => p.bucket_start)).toContain(dayAgo(1));
    expect(points.map((p) => p.bucket_start)).toContain(dayAgo(0));
  });
});

describe('what counts as money', () => {
  it('adds up the sales of a day', async () => {
    const { points } = await trends('days=7');
    const yesterday = pointOn(points, dayAgo(1));

    expect(yesterday.revenue).toBe(150); // (2 × 50) + (1 × 50)
    expect(yesterday.cogs).toBe(60); // 40 + 20
    expect(yesterday.gross_profit).toBe(90);
    expect(yesterday.order_count).toBe(2);
  });

  it('a voided sale is not revenue', async () => {
    // 20 × 50 = 1000 was voided three days ago. Counting it would nearly
    // sextuple the week; counting its cost would wreck the margin.
    const { points } = await trends('days=7');
    expect(pointOn(points, dayAgo(3)).revenue).toBe(50);
    expect(pointOn(points, dayAgo(3)).order_count).toBe(1);
  });

  it('splits waste from write-offs that are not waste', async () => {
    const { points } = await trends('days=7');
    const yesterday = pointOn(points, dayAgo(1));

    // A staff meal costs real money but is not food in a bin.
    expect(yesterday.write_off_cost).toBe(7);
    expect(yesterday.waste_cost).toBe(0);
  });

  it('dates buying by when it was PLACED, not when it was drafted', async () => {
    // Written five days ago, placed yesterday, 2 @ 11. A report keyed on
    // created_at puts this outside a shorter window entirely.
    const { points } = await trends('days=7');
    expect(pointOn(points, dayAgo(1)).purchasing_cost).toBe(22);
  });

  it('ignores a draft and a cancelled order', async () => {
    // 100 @ 9 never placed and 200 @ 9 cancelled. Either one leaking in would
    // dwarf everything real in the window.
    const { points } = await trends('days=7');
    expect(pointOn(points, dayAgo(2)).purchasing_cost).toBe(50); // 10 × 5, and nothing else
    expect(pointOn(points, dayAgo(3)).purchasing_cost).toBe(0);
  });

  it('the summary is the sum of the points', async () => {
    const { points, summary } = await trends('days=7');
    const total = (pick: (p: Point) => number) => points.reduce((s, p) => s + pick(p), 0);

    expect(summary.revenue).toBe(total((p) => p.revenue));
    expect(summary.cogs).toBe(total((p) => p.cogs));
    expect(summary.waste_cost).toBe(total((p) => p.waste_cost));
    expect(summary.purchasing_cost).toBe(total((p) => p.purchasing_cost));
    expect(summary.order_count).toBe(total((p) => p.order_count));
  });

  it('has no average ticket when nothing sold', async () => {
    // Null, not 0: there was no average, and a 0 would be plotted as a real
    // and very bad day.
    const { summary } = await trends('from=2001-01-01&to=2001-01-07');
    expect(summary.order_count).toBe(0);
    expect(summary.average_ticket).toBeNull();
    expect(summary.margin_pct).toBeNull();
  });
});

describe('wider buckets', () => {
  it('groups by week', async () => {
    const { points, bucket } = await trends('days=28&bucket=week');
    expect(bucket).toBe('week');
    // Four weeks of days cannot produce more than five week-buckets however
    // the window lands against Monday.
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points.length).toBeLessThanOrEqual(5);
  });

  it('groups by month, and the money survives regrouping', async () => {
    const daily = await trends('days=7');
    const monthly = await trends('days=7&bucket=month');

    expect(monthly.points.length).toBeLessThanOrEqual(2);
    // Regrouping must not create or destroy revenue.
    expect(monthly.summary.revenue).toBe(daily.summary.revenue);
  });

  it('refuses a bucket it cannot draw rather than quietly using days', async () => {
    // Silently substituting would label a chart with a period nobody asked for.
    const res = await request(app).get('/api/reports/trends?days=7&bucket=fortnight').set(asManager());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/day, week, month/);
  });

  it('still refuses a broken date range', async () => {
    const res = await request(app).get('/api/reports/trends?from=2026-05-01').set(asManager());
    expect(res.status).toBe(400);
  });
});

describe('who may see it', () => {
  it('an accountant may — this is the books', async () => {
    const { summary } = await trends('days=7', asAccountant());
    expect(summary.revenue).toBe(200);
  });

  it('a cashier may not', async () => {
    // SELECT is ungated in the database by design, so this route is the only
    // thing standing between a till operator and the restaurant's margins.
    const res = await request(app).get('/api/reports/trends?days=7').set(asCashier());
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/reports/trends?days=7')).status).toBe(401);
  });
});

describe('the tenant boundary', () => {
  it('never mixes in another restaurant, on any series', async () => {
    const { summary } = await trends('days=7');

    // Ours: 150 + 50. Theirs was 5000 revenue, 5000 waste, 4500 of buying —
    // any leak would be unmistakable.
    expect(summary.revenue).toBe(200);
    expect(summary.waste_cost).toBe(30);
    expect(summary.purchasing_cost).toBe(72); // 50 + 22
  });

  it('the foreign rows really are there — the fixture is not inert', async () => {
    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.orders WHERE organization_id = ${otherOrgId}::uuid`;
    expect(Number(row.count)).toBe(1);
  });
});
