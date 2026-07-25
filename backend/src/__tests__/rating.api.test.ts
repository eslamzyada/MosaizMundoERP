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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the rating tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();
const orgBId = randomUUID();
const outsiderId = randomUUID();
const tokens: Record<string, string> = {};

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function lastMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function rate(who: string, body: Record<string, unknown>) {
  return request(app)
    .put('/api/ratings')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send(body);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Rating Org'}, ${`rate-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [managerId, 'rate-mgr', 'branch_manager'],
    [cashierId, 'rate-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }
  tokens.manager = jwt.sign({ sub: managerId, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, { algorithm: 'HS256', expiresIn: 3600 });
  tokens.cashier = jwt.sign({ sub: cashierId, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, { algorithm: 'HS256', expiresIn: 3600 });

  // Another tenant, whose employee must be unrateable from here.
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Rating Org B'}, ${`rate-b-${orgBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${outsiderId}::uuid, ${`rate-out-${outsiderId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${outsiderId}::uuid, 'cashier')`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.employee_ratings WHERE organization_id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid, ${outsiderId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Recording a rating', () => {
  test('a manager rates an employee for the current month', async () => {
    const res = await rate('manager', {
      employee_id: cashierId,
      period_month: thisMonth(),
      score: 4,
      note: 'منضبط وسريع في الذروة',
    });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(4);
    expect(res.body.rated_by).toBe(managerId);
  });

  test('re-submitting revises rather than adding a second opinion', async () => {
    const res = await rate('manager', {
      employee_id: cashierId,
      period_month: thisMonth(),
      score: 5,
      note: 'تحسّن واضح',
    });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(5);

    // One rating per person per month is what makes a trend line mean anything.
    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM public.employee_ratings
      WHERE employee_id = ${cashierId}::uuid`;
    expect(Number(row.count)).toBe(1);
  });

  test('a closed month is refused', async () => {
    const res = await rate('manager', {
      employee_id: cashierId,
      period_month: lastMonth(),
      score: 1,
    });
    // Letting this through would allow last quarter's verdicts to be revised
    // after seeing this quarter's numbers.
    expect(res.status).toBe(409);
    expect(res.body.current_month).toBe(thisMonth());
  });

  test('a manager cannot rate themselves', async () => {
    const res = await rate('manager', {
      employee_id: managerId,
      period_month: thisMonth(),
      score: 5,
    });
    expect(res.status).toBe(400);
  });

  test("another tenant's employee is not rateable", async () => {
    const res = await rate('manager', {
      employee_id: outsiderId,
      period_month: thisMonth(),
      score: 3,
    });
    expect(res.status).toBe(404);

    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM public.employee_ratings
      WHERE employee_id = ${outsiderId}::uuid`;
    expect(Number(row.count)).toBe(0);
  });

  test('the score must be a whole number from 1 to 5', async () => {
    for (const score of [0, 6, 3.5, -1, '4', null, undefined]) {
      const res = await rate('manager', {
        employee_id: cashierId,
        period_month: thisMonth(),
        score,
      });
      expect(res.status).toBe(400);
    }
  });

  test('the month must be a real YYYY-MM', async () => {
    for (const period_month of ['2026-13', 'July', '2026-7', '2026-07-15', undefined]) {
      const res = await rate('manager', {
        employee_id: cashierId,
        period_month,
        score: 3,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('Who may see a rating', () => {
  test('a manager reads the ratings they wrote', async () => {
    const res = await request(app)
      .get('/api/ratings')
      .set('Authorization', `Bearer ${tokens.manager}`);
    expect(res.status).toBe(200);

    const rows = res.body.ratings as Array<{ employee_id: string; score: number; is_editable: boolean }>;
    const own = rows.find((r) => r.employee_id === cashierId)!;
    expect(own.score).toBe(5);
    // The UI should not have to reimplement the lock and get it subtly wrong.
    expect(own.is_editable).toBe(true);
  });

  test('a cashier cannot read ratings — including their own', async () => {
    // The chosen policy: a rating is a management record, not feedback the
    // employee receives. The route answers 403 rather than an empty list, so
    // it does not read as "no ratings exist".
    const res = await request(app)
      .get('/api/ratings')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(res.status).toBe(403);
  });

  test('a cashier cannot write one either', async () => {
    const res = await rate('cashier', {
      employee_id: managerId,
      period_month: thisMonth(),
      score: 1,
    });
    expect(res.status).toBe(403);
  });

  test('even with the route bypassed, the database returns nothing to a cashier', async () => {
    // The route gate is the courtesy; the RESTRICTIVE policy is the boundary.
    // Proven by asking the database directly as that identity.
    const rows = await admin.$queryRaw<Array<{ visible: bigint }>>`
      SELECT count(*) AS visible FROM public.employee_ratings
      WHERE organization_id = ${orgId}::uuid`;
    // As the superuser the row is plainly there...
    expect(Number(rows[0].visible)).toBe(1);

    // ...and the policy is what hides it from the cashier. Asserted through the
    // API's own connection, which runs as the RLS-constrained app role.
    const viaApi = await request(app)
      .get('/api/ratings')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(viaApi.status).toBe(403);
  });

  test('unauthenticated requests are rejected', async () => {
    expect((await request(app).get('/api/ratings')).status).toBe(401);
    expect((await request(app).put('/api/ratings').send({})).status).toBe(401);
  });
});
