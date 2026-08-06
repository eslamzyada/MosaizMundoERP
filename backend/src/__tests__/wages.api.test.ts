import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Pay, over HTTP (0042).
 *
 * The SQL suite proves the policies. What only this can prove is that the
 * REPORT tells the truth when it cannot see everything — a labour cost that
 * quietly omits the people whose pay you may not read is worse than no number,
 * because somebody will budget against it.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const waiterId = randomUUID();
const accountantId = randomUUID();

let ownerToken = '';
let managerToken = '';
let waiterToken = '';
let accountantToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

/** A date string, never a JS Date — see the note in setWage. */
const dayOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Wage Org'}, ${`wg-${orgId.slice(0, 8)}`}, 'basic')`;

  for (const [id, prefix, role] of [
    [ownerId, 'wg-own', 'owner'],
    [managerId, 'wg-man', 'branch_manager'],
    [waiterId, 'wg-wai', 'waiter'],
    [accountantId, 'wg-acc', 'accountant'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  ownerToken = sign(ownerId);
  managerToken = sign(managerId);
  waiterToken = sign(waiterId);
  accountantToken = sign(accountantId);

  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${orgId}::uuid, 'labour', true)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.employee_wages WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.time_entries WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.shifts WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${managerId}::uuid, ${waiterId}::uuid, ${accountantId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('setting pay', () => {
  it('the owner records a rate from a date', async () => {
    const res = await request(app)
      .post('/api/labour/wages')
      .set(as(ownerToken))
      .send({ user_id: waiterId, hourly_rate: 30, effective_from: dayOffset(-60) });

    expect(res.status).toBe(201);
    expect(res.body.effective_from).toBe(dayOffset(-60));
  });

  it('the date lands on the day asked for, not the one before', async () => {
    // @db.Date takes the UTC portion. A JS Date at local midnight east of UTC
    // becomes the previous day — the trap 0033 hit with period_month, and here
    // it would date a raise wrongly.
    const [row] = await admin.$queryRaw<Array<{ effective_from: Date }>>`
      SELECT effective_from FROM public.employee_wages
       WHERE user_id = ${waiterId}::uuid ORDER BY effective_from LIMIT 1`;
    expect(row.effective_from.toISOString().slice(0, 10)).toBe(dayOffset(-60));
  });

  it('a raise is a second row, and the first one stays', async () => {
    const res = await request(app)
      .post('/api/labour/wages')
      .set(as(ownerToken))
      .send({ user_id: waiterId, hourly_rate: 45, effective_from: dayOffset(0), note: 'علاوة' });
    expect(res.status).toBe(201);

    const history = await request(app)
      .get(`/api/labour/wages?user_id=${waiterId}`)
      .set(as(ownerToken));
    expect(history.body).toHaveLength(2);
  });

  it('two rates on the same day is a 409 that says why', async () => {
    const res = await request(app)
      .post('/api/labour/wages')
      .set(as(ownerToken))
      .send({ user_id: waiterId, hourly_rate: 99, effective_from: dayOffset(0) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_effective_date');
  });

  it('refuses a negative rate and a malformed date before the database has to', async () => {
    const negative = await request(app)
      .post('/api/labour/wages')
      .set(as(ownerToken))
      .send({ user_id: waiterId, hourly_rate: -5, effective_from: dayOffset(1) });
    expect(negative.status).toBe(400);

    const notADate = await request(app)
      .post('/api/labour/wages')
      .set(as(ownerToken))
      .send({ user_id: waiterId, hourly_rate: 30, effective_from: 'soon' });
    expect(notADate.status).toBe(400);
  });

  it('a branch manager may not set pay at all', async () => {
    const res = await request(app)
      .post('/api/labour/wages')
      .set(as(managerToken))
      .send({ user_id: waiterId, hourly_rate: 60, effective_from: dayOffset(2) });

    expect(res.status).toBe(403);
  });
});

describe('reading pay', () => {
  it('a waiter sees their own and nobody else\'s', async () => {
    await request(app)
      .post('/api/labour/wages')
      .set(as(ownerToken))
      .send({ user_id: managerId, hourly_rate: 70, effective_from: dayOffset(-30) });

    const res = await request(app).get('/api/labour/wages').set(as(waiterToken));
    expect(res.status).toBe(200);

    const subjects = new Set((res.body as Array<{ user_id: string }>).map((w) => w.user_id));
    expect(subjects.has(waiterId)).toBe(true);
    expect(subjects.has(managerId)).toBe(false);
  });

  it('a branch manager sees their own, and not the waiter\'s', async () => {
    // The interesting case: they write the rota and run the floor, and still
    // may not read what a colleague earns.
    const res = await request(app).get('/api/labour/wages').set(as(managerToken));
    const subjects = new Set((res.body as Array<{ user_id: string }>).map((w) => w.user_id));

    expect(subjects.has(managerId)).toBe(true);
    expect(subjects.has(waiterId)).toBe(false);
  });

  it('the accountant sees everybody, because payroll is their job', async () => {
    const res = await request(app).get('/api/labour/wages').set(as(accountantToken));
    const subjects = new Set((res.body as Array<{ user_id: string }>).map((w) => w.user_id));

    expect(subjects.has(waiterId)).toBe(true);
    expect(subjects.has(managerId)).toBe(true);
  });
});

describe('what an hour cost', () => {
  beforeAll(async () => {
    // Two entries, deliberately straddling the raise: one before it, one after.
    await admin.$executeRaw`
      INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
      VALUES (${orgId}::uuid, ${waiterId}::uuid,
              now() - interval '40 days', now() - interval '40 days' + interval '10 hours')`;
    await admin.$executeRaw`
      INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
      VALUES (${orgId}::uuid, ${waiterId}::uuid,
              now() - interval '2 hours', now() - interval '1 hour')`;
  });

  it('costs each entry at the rate that applied THEN, not today\'s', async () => {
    const res = await request(app)
      .get(`/api/labour/hours?from=${new Date(Date.now() - 60 * 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`)
      .set(as(ownerToken));

    expect(res.status).toBe(200);
    const row = res.body.by_employee.find((r: { user_id: string }) => r.user_id === waiterId);

    // 10h at 30 (the old rate) + 1h at 45 (the new one) = 345.
    // Multiplying 11 hours by today's 45 would give 495.
    expect(row.cost).toBeCloseTo(345, 1);
    expect(row.uncosted_entries).toBe(0);
  });

  it('reports UNKNOWN, never zero, for somebody with no rate', async () => {
    await admin.$executeRaw`
      INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
      VALUES (${orgId}::uuid, ${accountantId}::uuid,
              now() - interval '3 hours', now() - interval '2 hours')`;

    const res = await request(app)
      .get(`/api/labour/hours?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`)
      .set(as(ownerToken));

    const row = res.body.by_employee.find((r: { user_id: string }) => r.user_id === accountantId);
    expect(row.minutes).toBeGreaterThan(0);
    // Free labour is not the answer.
    expect(row.cost).toBeNull();
    expect(row.uncosted_entries).toBe(1);
    expect(res.body.uncosted_entries).toBeGreaterThan(0);
  });

  it('a branch manager gets the hours and NOT the cost', async () => {
    // The consequence of the confidentiality decision, and it is the correct
    // one: they may plan the rota without learning what people earn.
    const res = await request(app)
      .get(`/api/labour/hours?from=${new Date(Date.now() - 60 * 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`)
      .set(as(managerToken));

    const row = res.body.by_employee.find((r: { user_id: string }) => r.user_id === waiterId);
    expect(row).toBeDefined();
    expect(row.minutes).toBeGreaterThan(0);
    expect(row.cost).toBeNull();
  });

  it('the total names what it left out', async () => {
    const res = await request(app)
      .get(`/api/labour/hours?from=${new Date(Date.now() - 60 * 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`)
      .set(as(ownerToken));

    // A single number with silent gaps is worse than no number.
    expect(typeof res.body.total_cost).toBe('number');
    expect(res.body.uncosted_entries).toBeGreaterThan(0);
  });
});

describe('the module gate', () => {
  it('switching labour off stops new rates and keeps the history readable', async () => {
    await admin.$executeRaw`
      UPDATE public.organization_modules SET enabled = false
       WHERE organization_id = ${orgId}::uuid AND module_key = 'labour'`;

    const write = await request(app)
      .post('/api/labour/wages')
      .set(as(ownerToken))
      .send({ user_id: waiterId, hourly_rate: 55, effective_from: dayOffset(5) });
    expect(write.status).toBe(409);

    // Payroll for a month already worked still has to run.
    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.employee_wages WHERE organization_id = ${orgId}::uuid`;
    expect(Number(row.count)).toBeGreaterThan(0);

    await admin.$executeRaw`
      UPDATE public.organization_modules SET enabled = true
       WHERE organization_id = ${orgId}::uuid AND module_key = 'labour'`;
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/labour/wages')).status).toBe(401);
    expect((await request(app).post('/api/labour/wages').send({})).status).toBe(401);
  });
});
