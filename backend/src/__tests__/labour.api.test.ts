import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The rota and the clock over HTTP (0038).
 *
 * The SQL suite proves nobody can write an hour. What only this can prove is
 * that the API's refusals are answers rather than faults — "you are already
 * clocked in" is a state with a fix, and it must not arrive as a 500.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const waiterId = randomUUID();
const kitchenId = randomUUID();

let ownerToken = '';
let waiterToken = '';
let kitchenToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const iso = (offsetHours: number) =>
  new Date(Date.now() + offsetHours * 3600_000).toISOString();

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Labour Org'}, ${`lab-${orgId.slice(0, 8)}`}, 'enterprise')`;

  for (const [id, prefix, role] of [
    [ownerId, 'lab-own', 'owner'],
    [waiterId, 'lab-wai', 'waiter'],
    [kitchenId, 'lab-kit', 'kitchen'],
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
  waiterToken = sign(waiterId);
  kitchenToken = sign(kitchenId);

  // labour ships OFF. Enabled as the superuser here so the module gate itself
  // gets its own test below rather than being a precondition of every one.
  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${orgId}::uuid, 'labour', true)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.time_entries WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.shifts WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${waiterId}::uuid, ${kitchenId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('the rota', () => {
  it('a manager schedules somebody', async () => {
    const res = await request(app)
      .post('/api/labour/shifts')
      .set(as(ownerToken))
      .send({ user_id: waiterId, starts_at: iso(24), ends_at: iso(32), note: 'وردية المساء' });

    expect(res.status).toBe(201);
    expect(res.body.user_id).toBe(waiterId);
  });

  it('a waiter may READ the rota — it is a sheet of paper on the wall', async () => {
    const res = await request(app)
      .get(`/api/labour/shifts?from=${iso(0)}&to=${iso(72)}`)
      .set(as(waiterToken));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('a waiter may not write it', async () => {
    const res = await request(app)
      .post('/api/labour/shifts')
      .set(as(waiterToken))
      .send({ user_id: waiterId, starts_at: iso(100), ends_at: iso(104) });

    expect(res.status).toBe(403);
  });

  it('double-booking one person is a 409 that says so, not a 500', async () => {
    const res = await request(app)
      .post('/api/labour/shifts')
      .set(as(ownerToken))
      .send({ user_id: waiterId, starts_at: iso(28), ends_at: iso(36) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shift_overlap');
  });

  it('back to back is fine — the range is half-open', async () => {
    const res = await request(app)
      .post('/api/labour/shifts')
      .set(as(ownerToken))
      .send({ user_id: waiterId, starts_at: iso(32), ends_at: iso(38) });

    expect(res.status).toBe(201);
  });

  it('refuses a shift that ends before it starts, before the database has to', async () => {
    const res = await request(app)
      .post('/api/labour/shifts')
      .set(as(ownerToken))
      .send({ user_id: kitchenId, starts_at: iso(50), ends_at: iso(48) });

    expect(res.status).toBe(400);
  });
});

describe('the clock', () => {
  it('starts empty', async () => {
    const res = await request(app).get('/api/labour/clock').set(as(waiterToken));
    expect(res.status).toBe(200);
    expect(res.body.clocked_in).toBe(false);
  });

  it('a waiter clocks themselves in', async () => {
    const res = await request(app).post('/api/labour/clock-in').set(as(waiterToken));
    expect(res.status).toBe(201);

    const now = await request(app).get('/api/labour/clock').set(as(waiterToken));
    expect(now.body.clocked_in).toBe(true);
    expect(now.body.since).toBeTruthy();
  });

  it('clocking in twice is a 409 about the clock, not a server error', async () => {
    const res = await request(app).post('/api/labour/clock-in').set(as(waiterToken));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clock_state');
  });

  it('clocks out and reports the minutes', async () => {
    const res = await request(app).post('/api/labour/clock-out').set(as(waiterToken));
    expect(res.status).toBe(200);
    expect(typeof res.body.minutes).toBe('number');
    expect(res.body.minutes).toBeGreaterThanOrEqual(0);
  });

  it('clocking out twice is a 409 too', async () => {
    const res = await request(app).post('/api/labour/clock-out').set(as(waiterToken));
    expect(res.status).toBe(409);
  });
});

describe('hours', () => {
  it('a waiter sees only their own', async () => {
    await request(app).post('/api/labour/clock-in').set(as(kitchenToken));
    await request(app).post('/api/labour/clock-out').set(as(kitchenToken));

    const res = await request(app)
      .get(`/api/labour/hours?from=${iso(-24)}&to=${iso(24)}`)
      .set(as(waiterToken));

    expect(res.status).toBe(200);
    const ids = res.body.by_employee.map((r: { user_id: string }) => r.user_id);
    expect(ids).toContain(waiterId);
    // The own-row policy, not a role branch in the handler.
    expect(ids).not.toContain(kitchenId);
  });

  it('a manager sees everybody, from the same endpoint', async () => {
    const res = await request(app)
      .get(`/api/labour/hours?from=${iso(-24)}&to=${iso(24)}`)
      .set(as(ownerToken));

    const ids = res.body.by_employee.map((r: { user_id: string }) => r.user_id);
    expect(ids).toEqual(expect.arrayContaining([waiterId, kitchenId]));
  });
});

describe('amending', () => {
  it('a waiter cannot amend their own hours', async () => {
    const [entry] = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.time_entries WHERE user_id = ${waiterId}::uuid LIMIT 1`;

    const res = await request(app)
      .post(`/api/labour/entries/${entry.id}/amend`)
      .set(as(waiterToken))
      .send({ started_at: iso(-9), ended_at: iso(0), reason: 'نسيت' });

    expect(res.status).toBe(403);
  });

  it('a manager can, and must give a reason', async () => {
    const [entry] = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.time_entries WHERE user_id = ${waiterId}::uuid LIMIT 1`;

    const noReason = await request(app)
      .post(`/api/labour/entries/${entry.id}/amend`)
      .set(as(ownerToken))
      .send({ started_at: iso(-9), ended_at: iso(0), reason: '  ' });
    expect(noReason.status).toBe(400);

    const ok = await request(app)
      .post(`/api/labour/entries/${entry.id}/amend`)
      .set(as(ownerToken))
      .send({ started_at: iso(-9), ended_at: iso(0), reason: 'نسي تسجيل الانصراف' });
    expect(ok.status).toBe(200);

    const [after] = await admin.$queryRaw<Array<{ amended_by: string; amendment_reason: string }>>`
      SELECT amended_by, amendment_reason FROM public.time_entries WHERE id = ${entry.id}::uuid`;
    expect(after.amended_by).toBe(ownerId);
    expect(after.amendment_reason).toBe('نسي تسجيل الانصراف');
  });
});

describe('the module gate', () => {
  it('switching labour off answers 409 with the module name', async () => {
    await admin.$executeRaw`
      UPDATE public.organization_modules SET enabled = false
       WHERE organization_id = ${orgId}::uuid AND module_key = 'labour'`;

    const res = await request(app).get('/api/labour/shifts').set(as(ownerToken));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('module_disabled');
    expect(res.body.module).toBe('labour');
  });

  it('and the hours already worked are still on record', async () => {
    // The promise the whole module system rests on: off stops new work, it
    // does not rewrite the past. Read as the superuser because the route is
    // now gated — the ROWS are what matter here.
    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.time_entries WHERE organization_id = ${orgId}::uuid`;
    expect(Number(row.count)).toBeGreaterThan(0);

    await admin.$executeRaw`
      UPDATE public.organization_modules SET enabled = true
       WHERE organization_id = ${orgId}::uuid AND module_key = 'labour'`;
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/labour/shifts')).status).toBe(401);
    expect((await request(app).post('/api/labour/clock-in')).status).toBe(401);
  });
});
