import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The service report.
 *
 * Almost every assertion here is about a DISTINCTION the report has to keep,
 * and each one is a number somebody would otherwise manage a restaurant by:
 *
 *   absent  — this restaurant does not run that capability
 *   null    — it does, and the answer is not knowable (or not by this caller)
 *   0       — it does, and the answer is genuinely none
 *
 * Collapsing any pair of those produces a plausible, wrong figure. A tenant
 * with reservations switched off reading "0 covers" concludes the night was a
 * disaster; a branch manager reading "labour 0%" concludes wages are free.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const bareOrgId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const workerId = randomUUID();
// Someone who got a raise, to prove last month's report does not get one too.
const raisedId = randomUUID();
const bareOwnerId = randomUUID();

let ownerToken = '';
let managerToken = '';
let bareOwnerToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const window = `from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`;

beforeAll(async () => {
  for (const [id, name, slug] of [
    [orgId, 'Service Org', `svc-${orgId.slice(0, 8)}`],
    // A restaurant that runs NOTHING modular — the control for rule 1.
    [bareOrgId, 'Bare Org', `bare-${bareOrgId.slice(0, 8)}`],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${name}, ${slug}, 'enterprise')`;
  }

  for (const [id, prefix, role, org] of [
    [ownerId, 'svc-own', 'owner', orgId],
    [managerId, 'svc-man', 'branch_manager', orgId],
    [workerId, 'svc-wrk', 'waiter', orgId],
    [raisedId, 'svc-rse', 'waiter', orgId],
    [bareOwnerId, 'bare-own', 'owner', bareOrgId],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${org}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  ownerToken = sign(ownerId);
  managerToken = sign(managerId);
  bareOwnerToken = sign(bareOwnerId);

  for (const key of ['labour', 'reservations', 'public_ordering']) {
    await admin.$executeRaw`
      INSERT INTO public.organization_modules (organization_id, module_key, enabled)
      VALUES (${orgId}::uuid, ${key}, true)`;
  }
  // The bare restaurant explicitly runs none of them.
  for (const key of ['labour', 'reservations', 'public_ordering']) {
    await admin.$executeRaw`
      INSERT INTO public.organization_modules (organization_id, module_key, enabled)
      VALUES (${bareOrgId}::uuid, ${key}, false)`;
  }

  // A night's takings.
  await admin.$executeRaw`
    INSERT INTO public.orders (organization_id, client_offline_id, status, total_amount)
    VALUES (${orgId}::uuid, ${randomUUID()}::uuid, 'completed', 1000.00)`;

  // Ten hours worked, at 30 an hour — 300, which is 30% of the takings.
  await admin.$executeRaw`
    INSERT INTO public.employee_wages (organization_id, user_id, hourly_rate, effective_from, set_by)
    VALUES (${orgId}::uuid, ${workerId}::uuid, 30.00, (current_date - 30), ${ownerId}::uuid)`;
  await admin.$executeRaw`
    INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
    VALUES (${orgId}::uuid, ${workerId}::uuid, now() - interval '11 hours', now() - interval '1 hour')`;

  // A day the restaurant did not open, but someone still worked it — a deep
  // clean, four hours, at a rate that WAS in force (the wage starts 30 days
  // back). Cost known, takings zero. Without this the closed-day case is
  // reached with a null cost, which proves nothing about dividing by zero.
  await admin.$executeRaw`
    INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
    VALUES (${orgId}::uuid, ${workerId}::uuid,
            now() - interval '10 days', now() - interval '10 days' + interval '4 hours')`;

  // A raise. 20 an hour until today, 60 from today on — and two hours worked
  // twenty days ago, back when it was 20.
  //
  // This is the whole reason 0042 stores wages effective-dated instead of one
  // rate per person: costing an old shift at today's rate would rewrite what
  // last month cost every time somebody's pay changes. Nothing else in this
  // suite can tell the two apart, because nobody else's rate ever moves.
  await admin.$executeRaw`
    INSERT INTO public.employee_wages (organization_id, user_id, hourly_rate, effective_from, set_by)
    VALUES (${orgId}::uuid, ${raisedId}::uuid, 20.00, (current_date - 30), ${ownerId}::uuid)`;
  await admin.$executeRaw`
    INSERT INTO public.employee_wages (organization_id, user_id, hourly_rate, effective_from, set_by)
    VALUES (${orgId}::uuid, ${raisedId}::uuid, 60.00, current_date, ${ownerId}::uuid)`;
  await admin.$executeRaw`
    INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
    VALUES (${orgId}::uuid, ${raisedId}::uuid,
            now() - interval '20 days', now() - interval '20 days' + interval '2 hours')`;
});

afterAll(async () => {
  for (const id of [orgId, bareOrgId]) {
    await admin.$executeRaw`UPDATE public.reservations SET seated_order_id = NULL WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.public_order_lines WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.public_orders WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.reservations WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.employee_wages WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.time_entries WHERE organization_id = ${id}::uuid`;
    // Orders BEFORE tables: 0043 gave orders a table_id, so a table that has
    // held a tab is pinned until the tab is gone. Deleting in the old order
    // fails with a foreign key violation that says nothing about seating.
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.restaurant_tables WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${id}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${managerId}::uuid, ${workerId}::uuid, ${raisedId}::uuid, ${bareOwnerId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${bareOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('the number a restaurant is run by', () => {
  it('reports labour as a share of revenue', async () => {
    const res = await request(app).get(`/api/reports/service?${window}`).set(as(ownerToken));

    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(1000);
    // 10 hours at 30 = 300, against 1000 takings.
    expect(res.body.labour.cost).toBeCloseTo(300, 1);
    expect(res.body.labour.share_of_revenue).toBeCloseTo(30, 1);
  });

  it('refuses to divide by a closed day', async () => {
    // Takings of zero, and four hours worked at a KNOWN rate. An infinite wage
    // percentage is arithmetic, not information.
    //
    // The last step of this is not provable from out here, and saying so is
    // better than implying it is: total_amount is CHECKed >= 0, so revenue can
    // only ever be zero rather than negative, and JSON has no Infinity — it
    // serialises as null, the same value the guard produces deliberately. What
    // this CAN prove is that the branch is reached with a real cost in hand
    // instead of a null one, which is what it was quietly doing before.
    const closed = `from=${new Date(Date.now() - 10.5 * 86400_000).toISOString()}&to=${new Date(Date.now() - 9.5 * 86400_000).toISOString()}`;
    const res = await request(app).get(`/api/reports/service?${closed}`).set(as(ownerToken));

    expect(res.body.revenue).toBe(0);
    expect(res.body.labour.hours).toBeCloseTo(4, 1);
    expect(res.body.labour.cost).toBeCloseTo(120, 1); // 4 hours × 30
    expect(res.body.labour.uncosted_entries).toBe(0);
    expect(res.body.labour.share_of_revenue).toBeNull();
  });

  it('costs an old shift at the rate that applied THEN, not the rate now', async () => {
    // Two hours, twenty days ago, by someone earning 20 at the time and 60
    // today. The answer is 40. If it comes back 120, every historical report
    // in the system silently rewrites itself whenever somebody gets a raise.
    const then = `from=${new Date(Date.now() - 20.5 * 86400_000).toISOString()}&to=${new Date(Date.now() - 19.5 * 86400_000).toISOString()}`;
    const res = await request(app).get(`/api/reports/service?${then}`).set(as(ownerToken));

    expect(res.body.labour.hours).toBeCloseTo(2, 1);
    expect(res.body.labour.cost).toBeCloseTo(40, 1);
    expect(res.body.labour.cost).not.toBeCloseTo(120, 1);
  });
});

describe('absent, null and zero are three different answers', () => {
  it('a restaurant that runs none of it gets ABSENT sections', async () => {
    const res = await request(app).get(`/api/reports/service?${window}`).set(as(bareOwnerToken));

    expect(res.status).toBe(200);
    // Not `{ booked: 0 }` — that would read as a catastrophic night rather
    // than a restaurant that does not take bookings.
    expect(res.body.labour).toBeNull();
    expect(res.body.covers).toBeNull();
    expect(res.body.online).toBeNull();
  });

  it('a restaurant that DOES run it, with nothing to report, gets ZERO', async () => {
    const res = await request(app).get(`/api/reports/service?${window}`).set(as(ownerToken));

    // reservations is on and there are no bookings — a real zero.
    expect(res.body.covers).not.toBeNull();
    expect(res.body.covers.booked).toBe(0);
    expect(res.body.covers.no_show_rate).toBeNull(); // nothing decided yet
  });

  it('a caller who may not see pay gets NULL cost, and still gets the hours', async () => {
    // 0042: a branch manager may write the rota and may not read what it
    // costs. app.wage_at runs as them, so the report inherits that without a
    // role branch anywhere in this controller.
    const res = await request(app).get(`/api/reports/service?${window}`).set(as(managerToken));

    expect(res.status).toBe(200);
    expect(res.body.labour).not.toBeNull();
    expect(res.body.labour.hours).toBeGreaterThan(0);
    expect(res.body.labour.cost).toBeNull();
    // And therefore no percentage — not 0%.
    expect(res.body.labour.share_of_revenue).toBeNull();
    expect(res.body.labour.uncosted_entries).toBeGreaterThan(0);
  });
});

describe('covers', () => {
  it('counts bookings, and which of them became money', async () => {
    const table = await request(app)
      .post('/api/reservations/tables')
      .set(as(ownerToken))
      .send({ label: 'طاولة التقرير', seats: 4 });

    const soon = new Date(Date.now() + 3600_000).toISOString();
    const later = new Date(Date.now() + 7200_000).toISOString();

    const booking = await request(app)
      .post('/api/reservations')
      .set(as(ownerToken))
      .send({ table_id: table.body.id, guest_name: 'ضيف', party_size: 4, starts_at: soon, ends_at: later });

    await request(app).post(`/api/reservations/${booking.body.id}/seat`).set(as(ownerToken));

    const res = await request(app).get(`/api/reports/service?${window}`).set(as(ownerToken));

    expect(res.body.covers.booked).toBe(1);
    expect(res.body.covers.seated).toBe(1);
    // The link 0043 added, finally read.
    expect(res.body.covers.turned_into_money).toBe(1);
  });

  it('does not blame the restaurant for guests who cancelled', async () => {
    const table = await request(app)
      .post('/api/reservations/tables')
      .set(as(ownerToken))
      .send({ label: 'طاولة الإلغاء', seats: 2 });

    const soon = new Date(Date.now() + 10800_000).toISOString();
    const later = new Date(Date.now() + 14400_000).toISOString();

    const cancelled = await request(app)
      .post('/api/reservations')
      .set(as(ownerToken))
      .send({ table_id: table.body.id, guest_name: 'ملغي', party_size: 2, starts_at: soon, ends_at: later });
    await request(app)
      .post(`/api/reservations/${cancelled.body.id}/status`)
      .set(as(ownerToken))
      .send({ status: 'cancelled' });

    // And a guest who simply never arrived. Without a REAL no-show the rate is
    // zero over either denominator, and the test passes whichever one the
    // report divides by — which is exactly what it used to do.
    const ghostTable = await request(app)
      .post('/api/reservations/tables')
      .set(as(ownerToken))
      .send({ label: 'طاولة الغياب', seats: 2 });

    const ghost = await request(app)
      .post('/api/reservations')
      .set(as(ownerToken))
      .send({
        table_id: ghostTable.body.id,
        guest_name: 'غائب',
        party_size: 2,
        starts_at: soon,
        ends_at: later,
      });
    await request(app)
      .post(`/api/reservations/${ghost.body.id}/status`)
      .set(as(ownerToken))
      .send({ status: 'no_show' });

    const res = await request(app).get(`/api/reports/service?${window}`).set(as(ownerToken));
    const c = res.body.covers;

    expect(c.cancelled).toBeGreaterThan(0);
    expect(c.no_show).toBeGreaterThan(0);

    // A cancellation is not a no-show: one rang ahead, the other did not. They
    // are two different failures with two different fixes, so the rate is over
    // bookings that were DECIDED...
    const decided = c.seated + c.no_show;
    expect(c.no_show_rate).toBeCloseTo((c.no_show / decided) * 100, 1);

    // ...and NOT over everything booked, which would read the cancellations as
    // the restaurant's fault. The two differ only because a cancellation
    // exists, which is what the assertion above guarantees.
    expect(decided).not.toBe(c.booked);
    expect(c.no_show_rate).not.toBeCloseTo((c.no_show / c.booked) * 100, 1);
  });
});

describe('online orders', () => {
  it('separates what is still waiting from what was decided', async () => {
    await admin.$executeRaw`
      INSERT INTO public.public_orders
        (organization_id, customer_name, customer_phone, quoted_total, status)
      VALUES (${orgId}::uuid, ${'زبون'}, '01000000000', 50.00, 'pending')`;

    const res = await request(app).get(`/api/reports/service?${window}`).set(as(ownerToken));

    expect(res.body.online.received).toBe(1);
    expect(res.body.online.pending).toBe(1);
    // Nothing decided, so a rate would be invented.
    expect(res.body.online.acceptance_rate).toBeNull();
  });
});

describe('who may read it', () => {
  it('a waiter may not', async () => {
    const waiterToken = jwt.sign(
      { sub: workerId, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
    const res = await request(app).get(`/api/reports/service?${window}`).set(as(waiterToken));
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await request(app).get(`/api/reports/service?${window}`)).status).toBe(401);
  });

  it('refuses a window that runs backwards', async () => {
    const res = await request(app)
      .get(`/api/reports/service?from=${new Date().toISOString()}&to=${new Date(Date.now() - 86400_000).toISOString()}`)
      .set(as(ownerToken));
    expect(res.status).toBe(400);
  });
});
