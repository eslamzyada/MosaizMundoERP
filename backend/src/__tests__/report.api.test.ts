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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the report tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const accountantId = randomUUID();
const cashierId = randomUUID();

const alphaId = randomUUID(); // fully costed sales
const gammaId = randomUUID(); // sold with no recipe at all
const deltaId = randomUUID(); // blocked at the time, restocked since
const driedHerbId = randomUUID(); // the ingredient blocking Beta
const restockedId = randomUUID(); // the ingredient that has since arrived
const betaId = randomUUID(); // sold with an unknown cost

// A second tenant whose sales must never leak into these figures.
const orgBId = randomUUID();
const userBId = randomUUID();
const itemBId = randomUUID();

const tokens: Record<string, string> = {};

interface Bucket {
  revenue: number;
  costed_revenue: number;
  cogs: number;
  gross_profit: number;
  margin_pct: number | null;
  uncosted_revenue: number;
  uncosted_line_count: number;
  coverage_pct: number | null;
}
interface Gap {
  id: string;
  name: string;
  uncosted_line_count: number;
  uncosted_revenue: number;
  blocking_ingredients: Array<{ id: string; name: string; unit_of_measure: string }>;
  reason: 'no_recipe' | 'unstocked_ingredients' | 'already_resolved';
}
interface Report {
  days: number;
  summary: Bucket;
  by_day: Array<Bucket & { day: string }>;
  by_item: Array<Bucket & { id: string; name: string; units_sold: number }>;
  coverage_gaps: Gap[];
}

async function fetchReport(who: string, days?: number): Promise<Report> {
  const res = await request(app)
    .get(`/api/reports/profitability${days ? `?days=${days}` : ''}`)
    .set('Authorization', `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body as Report;
}

/** An order plus one line, written directly so the figures are exact. */
async function seedSale(opts: {
  org: string;
  item: string;
  qty: number;
  price: number;
  cost: number;
  complete: boolean;
  status?: string;
  daysAgo?: number;
}) {
  const orderId = randomUUID();
  const status = opts.status ?? 'completed';
  const daysAgo = opts.daysAgo ?? 0;
  // Since 0022 a voided order must carry a reason — orders_void_reason_matches_status
  // makes the reasonless void this fixture used to write an unrepresentable state.
  const voidReason = status === 'voided' ? 'wrong_item' : null;
  await admin.$executeRaw`
    INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount, created_at,
                               voided_at, void_reason, stock_restored)
    VALUES (${orderId}::uuid, ${opts.org}::uuid, ${randomUUID()}::uuid, ${status},
            ${opts.qty * opts.price}, now() - make_interval(days => ${daysAgo}::int),
            ${status === 'voided' ? new Date() : null}, ${voidReason}::text,
            ${status === 'voided' ? true : null})`;
  await admin.$executeRaw`
    INSERT INTO public.order_items
      (order_id, organization_id, sellable_item_id, quantity, unit_price, cost_at_sale, cost_is_complete)
    VALUES (${orderId}::uuid, ${opts.org}::uuid, ${opts.item}::uuid,
            ${opts.qty}, ${opts.price}, ${opts.cost}, ${opts.complete})`;
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Report Org'}, ${`rep-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'rep-owner', 'owner'],
    [accountantId, 'rep-acct', 'accountant'],
    [cashierId, 'rep-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${alphaId}::uuid, ${orgId}::uuid, ${'Alpha'}, ${'REP-A'}, 10)`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${betaId}::uuid, ${orgId}::uuid, ${'Beta'}, ${'REP-B'}, 20)`;

  // 2 x Alpha at 10, costing 6 in total. Fully costed.
  await seedSale({ org: orgId, item: alphaId, qty: 2, price: 10, cost: 6, complete: true });
  // 1 x Beta at 20, cost unknown (an ingredient was out of stock).
  await seedSale({ org: orgId, item: betaId, qty: 1, price: 20, cost: 5, complete: false });
  // A VOIDED sale that would badly distort every figure if counted.
  await seedSale({
    org: orgId, item: alphaId, qty: 5, price: 10, cost: 15, complete: true, status: 'voided',
  });
  // A real sale from 60 days ago, outside the default 30-day window.
  await seedSale({
    org: orgId, item: alphaId, qty: 3, price: 10, cost: 9, complete: true, daysAgo: 60,
  });

  // Beta has a recipe, but its ingredient has no stock — so it cannot be costed
  // and the gap report must name that ingredient as the blocker.
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${driedHerbId}::uuid, ${orgId}::uuid, ${'Dried Herb'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${betaId}::uuid, ${driedHerbId}::uuid, 5)`;

  // Gamma has NO recipe at all, and was sold uncosted.
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${gammaId}::uuid, ${orgId}::uuid, ${'Gamma'}, ${'REP-G'}, 30)`;
  await seedSale({ org: orgId, item: gammaId, qty: 1, price: 30, cost: 0, complete: false });

  // Delta was sold uncosted while its ingredient was out, but stock has since
  // arrived — the block is already fixed and nothing needs doing.
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${deltaId}::uuid, ${orgId}::uuid, ${'Delta'}, ${'REP-D'}, 40)`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${restockedId}::uuid, ${orgId}::uuid, ${'Restocked Spice'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${deltaId}::uuid, ${restockedId}::uuid, 2)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${restockedId}::uuid, 50, 50, 1.00)`;
  await seedSale({ org: orgId, item: deltaId, qty: 1, price: 40, cost: 0, complete: false });

  // Tenant B.
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Report Org B'}, ${`rep-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`rep-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${itemBId}::uuid, ${orgBId}::uuid, ${'Tenant B Dish'}, ${'REP-TB'}, 999)`;
  await seedSale({ org: orgBId, item: itemBId, qty: 7, price: 999, cost: 1, complete: true });
});

afterAll(async () => {
  // Order matters: bill_of_materials references BOTH sellable_items and
  // raw_inventory_items, so it has to go before either of them.
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${accountantId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Profitability report', () => {
  test('revenue, COGS and margin come out of the recorded cost', async () => {
    const { summary } = await fetchReport('owner');

    // In-window completed sales:
    //   Alpha 2x10 = 20   costed, COGS 6
    //   Beta  1x20 = 20   uncosted (its ingredient has no stock)
    //   Gamma 1x30 = 30   uncosted (no recipe)
    //   Delta 1x40 = 40   uncosted at the time, ingredient restocked since
    // The voided sale and the 60-day-old sale are outside this figure.
    expect(summary.revenue).toBeCloseTo(110, 6);
    expect(summary.costed_revenue).toBeCloseTo(20, 6);
    expect(summary.cogs).toBeCloseTo(6, 6);
    expect(summary.gross_profit).toBeCloseTo(14, 6);
    // Margin is 14/20 over COSTED revenue, not 14/40 over everything.
    expect(summary.margin_pct).toBeCloseTo(70, 3);
  });

  test('uncosted sales are excluded from margin but reported, not hidden', async () => {
    const { summary } = await fetchReport('owner');

    // Beta 20 + Gamma 30 + Delta 40.
    expect(summary.uncosted_revenue).toBeCloseTo(90, 6);
    expect(summary.uncosted_line_count).toBe(3);
    // The margin speaks for only 20 of 110 — the caller is told so rather than
    // being handed a figure that silently claims to cover everything.
    expect(summary.coverage_pct).toBeCloseTo(18.2, 1);
  });

  test('a voided order is not revenue and not cost', async () => {
    const { summary } = await fetchReport('owner');
    // Counting the voided 5x10 sale would put revenue at 160 and COGS at 21.
    expect(summary.revenue).toBeCloseTo(110, 6);
    expect(summary.cogs).toBeCloseTo(6, 6);
  });

  test('the window filters by date', async () => {
    const short = await fetchReport('owner', 30);
    const long = await fetchReport('owner', 365);

    expect(short.days).toBe(30);
    // The 60-day-old sale adds 3x10 = 30 revenue and 9 of cost.
    expect(long.summary.revenue).toBeCloseTo(short.summary.revenue + 30, 6);
    expect(long.summary.cogs).toBeCloseTo(short.summary.cogs + 9, 6);
  });

  test('the by-item breakdown separates the earner from the unknown', async () => {
    const { by_item } = await fetchReport('owner');

    const alpha = by_item.find((i) => i.id === alphaId)!;
    expect(alpha.units_sold).toBe(2); // the voided 5 are not sold
    expect(alpha.revenue).toBeCloseTo(20, 6);
    expect(alpha.cogs).toBeCloseTo(6, 6);
    expect(alpha.margin_pct).toBeCloseTo(70, 3);

    const beta = by_item.find((i) => i.id === betaId)!;
    expect(beta.units_sold).toBe(1);
    expect(beta.revenue).toBeCloseTo(20, 6);
    // Nothing about Beta's margin is known, so none is claimed.
    expect(beta.margin_pct).toBeNull();
    expect(beta.uncosted_line_count).toBe(1);
  });

  test('daily buckets sum to the headline figure', async () => {
    const { summary, by_day } = await fetchReport('owner');

    const revenue = by_day.reduce((s, d) => s + d.revenue, 0);
    const cogs = by_day.reduce((s, d) => s + d.cogs, 0);
    expect(revenue).toBeCloseTo(summary.revenue, 6);
    expect(cogs).toBeCloseTo(summary.cogs, 6);
  });

  test('an accountant may read the books; a cashier may not', async () => {
    const acct = await request(app)
      .get('/api/reports/profitability')
      .set('Authorization', `Bearer ${tokens.accountant}`);
    expect(acct.status).toBe(200);
    expect(acct.body.summary.revenue).toBeCloseTo(110, 6);

    // Ringing up a sale does not imply seeing what the restaurant makes on it.
    const cash = await request(app)
      .get('/api/reports/profitability')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(cash.status).toBe(403);
  });

  test("another tenant's sales never enter the figures", async () => {
    const { summary, by_item } = await fetchReport('owner');
    // Tenant B sold 7 x 999. If RLS leaked, revenue would be in the thousands.
    expect(summary.revenue).toBeCloseTo(110, 6);
    expect(by_item.some((i) => i.id === itemBId)).toBe(false);
  });

  describe('coverage gaps — why revenue could not be costed', () => {
    test('a dish with no recipe is named, with nothing blocking it', async () => {
      const { coverage_gaps } = await fetchReport('owner');
      const gamma = coverage_gaps.find((g) => g.id === gammaId)!;

      expect(gamma).toBeDefined();
      expect(gamma.reason).toBe('no_recipe');
      expect(gamma.blocking_ingredients).toEqual([]);
      expect(gamma.uncosted_revenue).toBeCloseTo(30, 6);
    });

    test('a dish blocked by an unstocked ingredient names that ingredient', async () => {
      const { coverage_gaps } = await fetchReport('owner');
      const beta = coverage_gaps.find((g) => g.id === betaId)!;

      expect(beta.reason).toBe('unstocked_ingredients');
      // The point of the whole feature: it says WHAT to restock.
      expect(beta.blocking_ingredients.map((b) => b.name)).toEqual(['Dried Herb']);
      expect(beta.blocking_ingredients[0].unit_of_measure).toBe('grams');
    });

    test('a dish whose blocker was since fixed is reported as resolved, not left open', async () => {
      const { coverage_gaps } = await fetchReport('owner');
      const delta = coverage_gaps.find((g) => g.id === deltaId)!;

      // It sold uncosted, so it still appears — but its ingredient is back in
      // stock, so there is nothing to do and the list must not demand action.
      expect(delta.reason).toBe('already_resolved');
      expect(delta.blocking_ingredients).toEqual([]);
    });

    test('a fully costed dish never appears in the gap list', async () => {
      const { coverage_gaps } = await fetchReport('owner');
      expect(coverage_gaps.some((g) => g.id === alphaId)).toBe(false);
    });

    test('the gaps account for exactly the summary uncosted revenue', async () => {
      const { summary, coverage_gaps } = await fetchReport('owner');

      const gapRevenue = coverage_gaps.reduce((s, g) => s + g.uncosted_revenue, 0);
      const gapLines = coverage_gaps.reduce((s, g) => s + g.uncosted_line_count, 0);
      // If these drifted apart, the fix-list would be describing a different
      // problem from the one the headline reports.
      expect(gapRevenue).toBeCloseTo(summary.uncosted_revenue, 6);
      expect(gapLines).toBe(summary.uncosted_line_count);
    });

    test("another tenant's uncosted sales never appear", async () => {
      const { coverage_gaps } = await fetchReport('owner');
      expect(coverage_gaps.some((g) => g.id === itemBId)).toBe(false);
    });
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/reports/profitability');
    expect(res.status).toBe(401);
  });
});
