import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The drawer over HTTP (0047).
 *
 * The SQL suite proves the arithmetic. What only this can prove is that the
 * two refusals arrive as answers a cashier can act on — "the till is already
 * open" and "the till is not open" are states, not bad requests, so they are
 * 409s — and that the number the screen shows is the number that was stored.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const cashierId = randomUUID();
const kitchenId = randomUUID();
const dishId = randomUUID();

let token = '';
let kitchenToken = '';
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await admin.$executeRaw`
    INSERT INTO public.organizations (id, name, slug, plan_tier)
    VALUES (${orgId}::uuid, ${'Till Org'}, ${`till-${orgId.slice(0, 8)}`}, 'enterprise')`;

  for (const [id, prefix, role] of [
    [cashierId, 'till-cash', 'cashier'],
    // Somebody who is a real member and may NOT sell. Without them, a refusal
    // below could be about belonging nowhere rather than about the role.
    [kitchenId, 'till-kit', 'kitchen'],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO public.users (id, email)
      VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`
      INSERT INTO public.organization_memberships (organization_id, user_id, role)
      VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  token = sign(cashierId);
  kitchenToken = sign(kitchenId);

  await admin.$executeRaw`
    INSERT INTO public.sellable_items (id, organization_id, name, sku, price)
    VALUES (${dishId}::uuid, ${orgId}::uuid, ${'شاي'}, ${'TILL-1'}, 20)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.order_payments WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.till_sessions WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.notifications WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${cashierId}::uuid, ${kitchenId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

/** A counter sale, paid however the caller says. */
async function sell(method: string, qty = 1) {
  const res = await request(app)
    .post('/api/pos/checkout')
    .set(as(token))
    .send({
      organization_id: orgId,
      client_offline_id: randomUUID(),
      items: [{ sellable_item_id: dishId, quantity: qty }],
      payments: [{ method, amount: 20 * qty }],
    });
  expect(res.status).toBeLessThan(300);
  return 20 * qty;
}

describe('is the drawer open?', () => {
  it('says NULL rather than pretending there is an empty session', async () => {
    const res = await request(app).get('/api/till').set(as(token));

    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
  });

  it('opens with a float and reports it back', async () => {
    const opened = await request(app)
      .post('/api/till/open')
      .set(as(token))
      .send({ opening_float: 100 });
    expect(opened.status).toBe(200);

    const res = await request(app).get('/api/till').set(as(token));
    expect(res.body.session.opening_float).toBe(100);
    expect(res.body.session.expected_so_far).toBe(100);
  });

  it('refuses a SECOND drawer as a 409 — a state, not a bad request', async () => {
    const res = await request(app)
      .post('/api/till/open')
      .set(as(token))
      .send({ opening_float: 0 });

    expect(res.status).toBe(409);
    expect(res.status).not.toBe(400);
  });
});

describe('what the running total counts', () => {
  it('adds cash to what should be in the drawer', async () => {
    const taken = await sell('cash');

    const res = await request(app).get('/api/till').set(as(token));
    expect(res.body.session.cash_taken).toBe(taken);
    expect(res.body.session.expected_so_far).toBe(100 + taken);
  });

  it('keeps CARD out of the drawer, and reports it separately', async () => {
    // Counting card here would have somebody counting to a number that was
    // never in the room, and reporting a shortfall the size of the day's card
    // takings. Dropping it entirely would hide real revenue.
    const before = await request(app).get('/api/till').set(as(token));
    await sell('card', 2);
    const after = await request(app).get('/api/till').set(as(token));

    expect(after.body.session.expected_so_far).toBe(before.body.session.expected_so_far);
    expect(after.body.session.other_taken).toBe(40);
  });
});

describe('closing it', () => {
  it('requires the drawer to have been counted', async () => {
    // No default. A close that assumed the drawer held exactly what it should
    // would report a variance of zero every night — the one answer this must
    // never invent.
    const res = await request(app).post('/api/till/close').set(as(token)).send({});

    expect(res.status).toBe(400);
  });

  it('returns the variance, and it is real arithmetic', async () => {
    const current = await request(app).get('/api/till').set(as(token));
    const expected = current.body.session.expected_so_far;

    const res = await request(app)
      .post('/api/till/close')
      .set(as(token))
      .send({ counted_cash: expected - 15 });

    expect(res.status).toBe(200);
    expect(res.body.expected_cash).toBe(expected);
    expect(res.body.counted_cash).toBe(expected - 15);
    expect(res.body.variance).toBe(-15);
  });

  it('the number it returns is the number that was STORED', async () => {
    // Not recomputed in the handler: the row is the record, and a second
    // implementation of the number a cashier is held to could only disagree.
    const row = await admin.$queryRaw<Array<{ variance: string }>>`
      SELECT variance::text FROM public.till_sessions
       WHERE organization_id = ${orgId}::uuid AND closed_at IS NOT NULL
       ORDER BY closed_at DESC LIMIT 1`;

    expect(Number(row[0].variance)).toBe(-15);
  });

  it('refuses to close a drawer that is not open, as a 409', async () => {
    const res = await request(app)
      .post('/api/till/close')
      .set(as(token))
      .send({ counted_cash: 0 });

    expect(res.status).toBe(409);
  });

  it('leaves the drawer shut afterwards', async () => {
    const res = await request(app).get('/api/till').set(as(token));
    expect(res.body.session).toBeNull();
  });
});

describe('who may work the till', () => {
  it('refuses somebody who does not sell', async () => {
    // A real member of the same restaurant, so this is about the role.
    const res = await request(app)
      .post('/api/till/open')
      .set(as(kitchenToken))
      .send({ opening_float: 0 });

    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/till')).status).toBe(401);
  });
});
