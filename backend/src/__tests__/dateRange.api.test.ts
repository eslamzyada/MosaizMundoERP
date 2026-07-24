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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the date range tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const dishId = randomUUID();
const tokens: Record<string, string> = {};

/** A calendar date N days back, in the same local form the API accepts. */
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Seeds one completed sale at a precise instant. */
async function sale(at: Date, revenue: number, cost: number) {
  const orderId = randomUUID();
  await admin.$executeRaw`
    INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount, created_at)
    VALUES (${orderId}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 'completed', ${revenue}, ${at})`;
  await admin.$executeRaw`
    INSERT INTO public.order_items
      (order_id, organization_id, sellable_item_id, quantity, unit_price, cost_at_sale, cost_is_complete)
    VALUES (${orderId}::uuid, ${orgId}::uuid, ${dishId}::uuid, 1, ${revenue}, ${cost}, true)`;
}

async function profitability(query: string) {
  return request(app)
    .get(`/api/reports/profitability?${query}`)
    .set('Authorization', `Bearer ${tokens.owner}`);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Range Org'}, ${`rng-${orgId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${ownerId}::uuid, ${`rng-${ownerId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${ownerId}::uuid, 'owner')`;
  tokens.owner = jwt.sign(
    { sub: ownerId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${dishId}::uuid, ${orgId}::uuid, ${'Range Dish'}, ${'RNG-1'}, 100)`;

  // Three sales pinned to instants that matter for a half-open interval.
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  threeDaysAgo.setHours(12, 0, 0, 0);
  await sale(threeDaysAgo, 100, 40);

  // 23:59 on the day BEFORE yesterday's boundary — the sale a naive `<= to`
  // comparison drops, because it lands after midnight-of-the-end-date.
  const lateOnBoundary = new Date();
  lateOnBoundary.setDate(lateOnBoundary.getDate() - 2);
  lateOnBoundary.setHours(23, 59, 0, 0);
  await sale(lateOnBoundary, 200, 80);

  // Well outside any short window.
  const longAgo = new Date();
  longAgo.setDate(longAgo.getDate() - 200);
  await sale(longAgo, 999, 500);
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Reporting over an explicit date range', () => {
  test('from/to covers both endpoints inclusively', async () => {
    const res = await profitability(`from=${dayOffset(-3)}&to=${dayOffset(-2)}`);
    expect(res.status).toBe(200);
    // 100 on day -3 and 200 on day -2.
    expect(res.body.summary.revenue).toBeCloseTo(300, 2);
  });

  test('a sale at 23:59 on the final day is INSIDE the range', async () => {
    // The bug a half-open interval exists to prevent: comparing `<= to` where
    // `to` is midnight silently drops the busiest hour of the last day.
    const res = await profitability(`from=${dayOffset(-2)}&to=${dayOffset(-2)}`);
    expect(res.body.summary.revenue).toBeCloseTo(200, 2);
  });

  test('a single day selects only that day', async () => {
    const res = await profitability(`from=${dayOffset(-3)}&to=${dayOffset(-3)}`);
    expect(res.body.summary.revenue).toBeCloseTo(100, 2);
  });

  test('the response says which period it covers', async () => {
    const res = await profitability(`from=${dayOffset(-3)}&to=${dayOffset(-2)}`);
    expect(res.body.from).toBe(dayOffset(-3));
    expect(res.body.to).toBe(dayOffset(-2));
    // days is null for an explicit range: it was not a rolling window.
    expect(res.body.days).toBeNull();
  });

  test('the rolling window still works and still includes today', async () => {
    const res = await profitability('days=7');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    // The 200-day-old sale is excluded; the two recent ones are not.
    expect(res.body.summary.revenue).toBeCloseTo(300, 2);
  });

  test('an unparseable date is refused rather than quietly ignored', async () => {
    // Falling back to a default would answer a question nobody asked.
    for (const q of ['from=yesterday&to=today', 'from=2026-13-45&to=2026-01-01', 'from=01-07-2026&to=02-07-2026']) {
      const res = await profitability(q);
      expect(res.status).toBe(400);
    }
  });

  test('a reversed range is refused', async () => {
    const res = await profitability(`from=${dayOffset(-1)}&to=${dayOffset(-5)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/after/i);
  });

  test('half a range is refused — an open-ended report is a trap', async () => {
    expect((await profitability(`from=${dayOffset(-5)}`)).status).toBe(400);
    expect((await profitability(`to=${dayOffset(-1)}`)).status).toBe(400);
  });

  test('the voids and waste reports take the same range', async () => {
    for (const path of ['voids', 'waste']) {
      const ok = await request(app)
        .get(`/api/reports/${path}?from=${dayOffset(-3)}&to=${dayOffset(-1)}`)
        .set('Authorization', `Bearer ${tokens.owner}`);
      expect(ok.status).toBe(200);
      expect(ok.body.from).toBe(dayOffset(-3));

      const bad = await request(app)
        .get(`/api/reports/${path}?from=nonsense&to=${dayOffset(-1)}`)
        .set('Authorization', `Bearer ${tokens.owner}`);
      expect(bad.status).toBe(400);
    }
  });
});
