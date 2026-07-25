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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the employee report tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const busyId = randomUUID(); // serves a lot
const quietId = randomUUID(); // serves little, and gets voided
const dishId = randomUUID();
const tokens: Record<string, string> = {};

interface EmployeeRow {
  user_id: string;
  email: string;
  role: string;
  orders_served: number;
  revenue: number;
  average_order_value: number | null;
  voided_orders: number;
  void_rate_pct: number | null;
  revenue_share_pct: number | null;
}

async function checkout(who: string, amount: number) {
  const res = await request(app)
    .post('/api/pos/checkout')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send({
      organization_id: orgId,
      client_offline_id: randomUUID(),
      items: [{ sellable_item_id: dishId, quantity: amount }],
    });
  expect(res.status).toBe(200);
  return res.body.order_id as string;
}

async function report(who: string, query = 'days=30') {
  return request(app)
    .get(`/api/reports/employees?${query}`)
    .set('Authorization', `Bearer ${tokens[who]}`);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Perf Org'}, ${`perf-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'perf-owner', 'owner'],
    [busyId, 'perf-busy', 'cashier'],
    [quietId, 'perf-quiet', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }
  // Two cashiers need distinct tokens, so key them by name rather than role.
  tokens.owner = jwt.sign({ sub: ownerId, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, { algorithm: 'HS256', expiresIn: 3600 });
  tokens.busy = jwt.sign({ sub: busyId, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, { algorithm: 'HS256', expiresIn: 3600 });
  tokens.quiet = jwt.sign({ sub: quietId, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, { algorithm: 'HS256', expiresIn: 3600 });

  // A dish with no recipe: this suite is about attribution, not stock.
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${dishId}::uuid, ${orgId}::uuid, ${'Perf Dish'}, ${'PERF-1'}, 50)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.inventory_consumption WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${busyId}::uuid, ${quietId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Employee performance', () => {
  beforeAll(async () => {
    // busy: 3 sales — 2x50, 1x50, 3x50 = 300.00 across 3 orders.
    await checkout('busy', 2);
    await checkout('busy', 1);
    await checkout('busy', 3);
    // quiet: 1 sale of 50.00, plus one that gets voided.
    await checkout('quiet', 1);
    const doomed = await checkout('quiet', 2);
    const voided = await request(app)
      .post(`/api/pos/orders/${doomed}/void`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ restore_stock: true, void_reason: 'wrong_item' });
    expect(voided.status).toBe(200);
  });

  test('each person is credited with the sales they actually served', async () => {
    const res = await report('owner');
    expect(res.status).toBe(200);

    const rows = res.body.employees as EmployeeRow[];
    const busy = rows.find((r) => r.user_id === busyId)!;
    const quiet = rows.find((r) => r.user_id === quietId)!;

    expect(busy.orders_served).toBe(3);
    expect(busy.revenue).toBeCloseTo(300, 2); // (2+1+3) x 50
    expect(quiet.orders_served).toBe(1);
    expect(quiet.revenue).toBeCloseTo(50, 2);
  });

  test('average order value distinguishes a big till from a busy one', async () => {
    const res = await report('owner');
    const busy = (res.body.employees as EmployeeRow[]).find((r) => r.user_id === busyId)!;
    // 300 over 3 orders.
    expect(busy.average_order_value).toBeCloseTo(100, 2);
  });

  test('the void rate is over THEIR OWN sales, not voids they authorised', async () => {
    // The owner authorised the void; the cashier's sale is what was voided. A
    // report that measured voids authorised would blame the wrong person.
    const res = await report('owner');
    const rows = res.body.employees as EmployeeRow[];
    const quiet = rows.find((r) => r.user_id === quietId)!;
    const owner = rows.find((r) => r.user_id === ownerId);

    expect(quiet.voided_orders).toBe(1);
    // 1 void out of 2 orders rung up.
    expect(quiet.void_rate_pct).toBeCloseTo(50, 1);
    // The owner served nothing, so they should not appear at all.
    expect(owner).toBeUndefined();
  });

  test('every figure is ranked against the team, not an absolute bar', async () => {
    const res = await report('owner');
    const team = res.body.team;

    // "3 orders" means nothing alone; "3 against an average of 2" is a judgement.
    expect(team.headcount).toBe(2);
    expect(team.orders_served).toBe(4);
    expect(team.average_orders_per_person).toBeCloseTo(2, 1);
    expect(team.revenue).toBeCloseTo(350, 2);
    expect(team.average_order_value).toBeCloseTo(87.5, 2);

    const busy = (res.body.employees as EmployeeRow[]).find((r) => r.user_id === busyId)!;
    expect(busy.revenue_share_pct).toBeCloseTo(85.7, 1);
  });

  test('sales with no recorded server are reported, not hidden', async () => {
    // The 0026 reality: orders placed before attribution existed have no server
    // and never will. Dropping them would make the per-person totals silently
    // fail to reconcile against the business total.
    const orphan = randomUUID();
    await admin.$executeRaw`
      INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount)
      VALUES (${orphan}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 'completed', 90)`;

    const res = await report('owner');
    expect(res.body.unattributed.present).toBe(true);
    expect(res.body.unattributed.orders_served).toBe(1);
    expect(res.body.unattributed.revenue).toBeCloseTo(90, 2);

    // And it stays OUT of the per-person figures, so nobody is credited with it.
    const rows = res.body.employees as EmployeeRow[];
    expect(rows.reduce((s, r) => s + r.revenue, 0)).toBeCloseTo(350, 2);
    expect(res.body.team.revenue).toBeCloseTo(350, 2);

    await admin.$executeRaw`DELETE FROM public.orders WHERE id = ${orphan}::uuid`;
  });

  test('the window filters by date', async () => {
    await admin.$executeRaw`
      UPDATE public.orders SET created_at = now() - interval '90 days'
      WHERE organization_id = ${orgId}::uuid AND served_by = ${busyId}::uuid`;

    const near = await report('owner', 'days=30');
    expect((near.body.employees as EmployeeRow[]).find((r) => r.user_id === busyId)).toBeUndefined();

    const far = await report('owner', 'days=180');
    expect((far.body.employees as EmployeeRow[]).find((r) => r.user_id === busyId)).toBeDefined();

    await admin.$executeRaw`
      UPDATE public.orders SET created_at = now()
      WHERE organization_id = ${orgId}::uuid AND served_by = ${busyId}::uuid`;
  });

  test('a cashier may not read the team\'s takings', async () => {
    expect((await report('busy')).status).toBe(403);
  });

  test('a bad range is refused', async () => {
    expect((await report('owner', 'from=nonsense&to=2026-01-01')).status).toBe(400);
  });
});
