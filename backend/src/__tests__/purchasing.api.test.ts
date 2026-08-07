import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * What the restaurant bought.
 *
 * Two numbers here are easy to conflate and the difference is the whole report:
 * what was ORDERED and what actually ARRIVED. A partly delivered order is the
 * normal case, and a report that quotes only one of them either hides money
 * owed to a supplier or hides stock that never turned up.
 *
 * The other thing worth pinning is that `open_orders` is deliberately NOT
 * scoped to the window. An order placed three months ago and never delivered is
 * exactly the one worth chasing — and a window-scoped figure drops it the day
 * it ages out, which is the day it starts to matter.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the purchasing tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();

const cheapSupplierId = randomUUID();
const bigSupplierId = randomUUID();
const foreignSupplierId = randomUUID();
const flourId = randomUUID();
const oilId = randomUUID();
const foreignItemId = randomUUID();

let managerToken = '';
let cashierToken = '';

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asCashier = () => ({ Authorization: `Bearer ${cashierToken}` });

const at = (n: number) => `date_trunc('day', now()) - interval '${n} days' + interval '10 hours'`;

async function seedPo(opts: {
  org: string;
  supplier: string;
  status: string;
  placedDaysAgo: number | null;
  lines: Array<{ item: string; ordered: number; received: number; unitPrice: number }>;
}) {
  const poId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO public.purchase_orders (id, organization_id, supplier_id, status, created_at, placed_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ${at(opts.placedDaysAgo ?? 1)},
             ${opts.placedDaysAgo === null ? 'NULL' : at(opts.placedDaysAgo)})`,
    poId,
    opts.org,
    opts.supplier,
    opts.status,
  );
  for (const line of opts.lines) {
    await admin.$executeRawUnsafe(
      `INSERT INTO public.purchase_order_lines
         (purchase_order_id, organization_id, raw_item_id, quantity_ordered, quantity_received, unit_price)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
      poId,
      opts.org,
      line.item,
      line.ordered,
      line.received,
      line.unitPrice,
    );
  }
  return poId;
}

beforeAll(async () => {
  for (const [id, label] of [
    [orgId, 'Buying Org'],
    [otherOrgId, 'Other Buying Org'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${label}, ${`buy-${id.slice(0, 8)}`}, 'enterprise')`;
  }

  for (const [id, prefix, role] of [
    [managerId, 'buy-mgr', 'branch_manager'],
    [cashierId, 'buy-csh', 'cashier'],
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

  await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${cheapSupplierId}::uuid, ${orgId}::uuid, ${'مورّد صغير'})`;
  await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${bigSupplierId}::uuid, ${orgId}::uuid, ${'مورّد كبير'})`;
  await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${foreignSupplierId}::uuid, ${otherOrgId}::uuid, ${'مورّد غريب'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${flourId}::uuid, ${orgId}::uuid, ${'دقيق'}, 'kg')`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${oilId}::uuid, ${orgId}::uuid, ${'زيت'}, 'L')`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${foreignItemId}::uuid, ${otherOrgId}::uuid, ${'سكر'}, 'kg')`;

  // Big supplier: 100 flour @ 10 = 1000 committed, 60 received = 600, 400 owed.
  await seedPo({
    org: orgId,
    supplier: bigSupplierId,
    status: 'placed',
    placedDaysAgo: 2,
    lines: [{ item: flourId, ordered: 100, received: 60, unitPrice: 10 }],
  });

  // Small supplier: fully delivered, and one line OVER-delivered.
  await seedPo({
    org: orgId,
    supplier: cheapSupplierId,
    status: 'received',
    placedDaysAgo: 1,
    lines: [
      { item: oilId, ordered: 10, received: 10, unitPrice: 20 },
      // 5 ordered, 7 arrived: outstanding must be 0, never negative.
      { item: flourId, ordered: 5, received: 7, unitPrice: 12 },
    ],
  });

  // Neither of these is spending.
  await seedPo({
    org: orgId,
    supplier: bigSupplierId,
    status: 'draft',
    placedDaysAgo: null,
    lines: [{ item: flourId, ordered: 999, received: 0, unitPrice: 100 }],
  });
  await seedPo({
    org: orgId,
    supplier: bigSupplierId,
    status: 'cancelled',
    placedDaysAgo: 2,
    lines: [{ item: flourId, ordered: 888, received: 0, unitPrice: 100 }],
  });

  // Placed long before any window this suite asks for, still undelivered.
  await seedPo({
    org: orgId,
    supplier: cheapSupplierId,
    status: 'placed',
    placedDaysAgo: 200,
    lines: [{ item: oilId, ordered: 3, received: 0, unitPrice: 100 }],
  });

  // Another restaurant, same window, loud numbers.
  await seedPo({
    org: otherOrgId,
    supplier: foreignSupplierId,
    status: 'placed',
    placedDaysAgo: 2,
    lines: [{ item: foreignItemId, ordered: 5000, received: 0, unitPrice: 50 }],
  });
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.purchase_order_lines WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.purchase_orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

interface Purchasing {
  summary: {
    committed: number;
    received: number;
    outstanding: number;
    fulfilment_pct: number | null;
    order_count: number;
    supplier_count: number;
    open_orders: { order_count: number; outstanding: number; oldest_placed_at: string | null };
  };
  by_supplier: Array<{
    id: string;
    name: string;
    order_count: number;
    committed: number;
    received: number;
    outstanding: number;
  }>;
  by_status: Array<{ status: string; order_count: number; committed: number }>;
  by_item: Array<{ id: string; name: string; quantity_ordered: number; committed: number; last_unit_price: number }>;
}

async function purchasing(query = 'days=7', headers = asManager()): Promise<Purchasing> {
  const res = await request(app).get(`/api/reports/purchasing?${query}`).set(headers);
  expect(res.status).toBe(200);
  return res.body as Purchasing;
}

describe('ordered versus arrived', () => {
  it('reports both, and they are not the same number', async () => {
    const { summary } = await purchasing();

    // 1000 (big) + 200 (oil) + 60 (flour @ 12) = 1260 committed.
    expect(summary.committed).toBe(1260);
    // 600 + 200 + 84 (7 × 12) = 884 arrived.
    expect(summary.received).toBe(884);
  });

  it('outstanding is what was promised and has not turned up', async () => {
    const { by_supplier } = await purchasing();
    const big = by_supplier.find((s) => s.id === bigSupplierId)!;

    expect(big.committed).toBe(1000);
    expect(big.received).toBe(600);
    expect(big.outstanding).toBe(400);
  });

  it('an OVER-delivery is nothing outstanding, never a negative', async () => {
    // 5 ordered, 7 received. Without the GREATEST guard this line contributes
    // −24, quietly cancelling out real debt on another line of the same order.
    const { by_supplier } = await purchasing();
    const small = by_supplier.find((s) => s.id === cheapSupplierId)!;

    expect(small.outstanding).toBe(0);
    expect(small.committed).toBe(260); // 200 + 60
    expect(small.received).toBe(284); // more than committed, which is the point
  });

  it('says how much of what was ordered actually came', async () => {
    const { summary } = await purchasing();
    expect(summary.fulfilment_pct).toBeCloseTo(70.2, 1); // 884 / 1260
  });
});

describe('what is not spending', () => {
  it('leaves a draft and a cancelled order out of the money', async () => {
    // 999 × 100 and 888 × 100. Either leaking in would be six figures against
    // a real total of 1260.
    const { summary } = await purchasing();
    expect(summary.committed).toBe(1260);
  });

  it('but STILL shows them in the status breakdown', async () => {
    // This is where you find out half the orders never got placed — which the
    // spend figures deliberately hide.
    const { by_status } = await purchasing();
    const statuses = by_status.map((s) => s.status);

    expect(statuses).toContain('draft');
    expect(statuses).toContain('cancelled');
    expect(by_status.find((s) => s.status === 'draft')!.committed).toBe(99900);
  });
});

describe('orders still owed to us', () => {
  it('counts one placed long before the window', async () => {
    // Placed 200 days ago, never delivered, and the window is seven days. A
    // window-scoped figure loses it exactly when it becomes worth chasing.
    const { summary } = await purchasing('days=7');

    // 400 still owed by the big supplier + 300 from the ancient order.
    expect(summary.open_orders.outstanding).toBe(700);
    expect(summary.open_orders.order_count).toBe(2);
  });

  it('names how long the oldest has been waiting', async () => {
    const { summary } = await purchasing('days=7');
    expect(summary.open_orders.oldest_placed_at).not.toBeNull();

    const age = (Date.now() - new Date(summary.open_orders.oldest_placed_at!).getTime()) / 86_400_000;
    expect(age).toBeGreaterThan(190);
  });

  it('the window figure and the open figure disagree, on purpose', async () => {
    const { summary } = await purchasing('days=7');
    // In-window outstanding counts only the recent order; open counts both.
    expect(summary.outstanding).toBe(400);
    expect(summary.open_orders.outstanding).toBe(700);
  });
});

describe('the breakdowns', () => {
  it('ranks suppliers by what was committed to them', async () => {
    const { by_supplier } = await purchasing();
    expect(by_supplier[0].id).toBe(bigSupplierId);
  });

  it('reports the LATEST price agreed for an ingredient, not an average', async () => {
    // Flour was bought at 10 two days ago and at 12 yesterday. An average (11)
    // is a number nobody will ever pay; the next delivery costs 12.
    const { by_item } = await purchasing();
    const flour = by_item.find((i) => i.id === flourId)!;

    expect(flour.last_unit_price).toBe(12);
    expect(flour.quantity_ordered).toBe(105);
    expect(flour.committed).toBe(1060);
  });

  it('counts each order once even when it has several lines', async () => {
    // The small supplier's order has two lines. A COUNT without DISTINCT makes
    // one delivery look like two.
    const { by_supplier, summary } = await purchasing();
    expect(by_supplier.find((s) => s.id === cheapSupplierId)!.order_count).toBe(1);
    expect(summary.order_count).toBe(2);
  });
});

describe('who may see it, and whose it is', () => {
  it('a cashier may not', async () => {
    const res = await request(app).get('/api/reports/purchasing?days=7').set(asCashier());
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/reports/purchasing?days=7')).status).toBe(401);
  });

  it('never counts another restaurant, on any figure', async () => {
    const { summary, by_supplier } = await purchasing();

    // Theirs was 5000 × 50 = 250,000 — a leak would be unmissable.
    expect(summary.committed).toBe(1260);
    expect(by_supplier.map((s) => s.id)).not.toContain(foreignSupplierId);
  });

  it('the foreign order really is there — the fixture is not inert', async () => {
    const [row] = await admin.$queryRaw<Array<{ committed: number }>>`
      SELECT COALESCE(SUM(l.quantity_ordered * l.unit_price), 0)::float8 AS committed
        FROM public.purchase_order_lines l
       WHERE l.organization_id = ${otherOrgId}::uuid`;
    expect(Number(row.committed)).toBe(250000);
  });

  it('refuses a broken date range', async () => {
    const res = await request(app).get('/api/reports/purchasing?to=2026-01-01').set(asManager());
    expect(res.status).toBe(400);
  });
});
