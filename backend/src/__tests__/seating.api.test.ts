import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Seating over HTTP (0043).
 *
 * The SQL suite proves the one-tab-per-table rule. What only this can prove is
 * that a host on the floor gets an answer they can act on — "that table is
 * occupied" is a different problem from "that booking was cancelled", and both
 * are different from a 500.
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
let waiterToken = '';
let ownerToken = '';
let tableId = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const BASE = Date.now();
const at = (h: number) => new Date(BASE + h * 3600_000).toISOString();

const book = async (name: string, hours: number) => {
  const res = await request(app)
    .post('/api/reservations')
    .set(as(waiterToken))
    .send({
      table_id: tableId,
      guest_name: name,
      party_size: 2,
      starts_at: at(hours),
      ends_at: at(hours + 2),
    });
  return res.body.id as string;
};

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Seat Org'}, ${`seat-${orgId.slice(0, 8)}`}, 'enterprise')`;

  for (const [id, prefix, role] of [
    [ownerId, 'seat-own', 'owner'],
    [waiterId, 'seat-wai', 'waiter'],
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

  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${orgId}::uuid, 'reservations', true)`;

  const table = await request(app)
    .post('/api/reservations/tables')
    .set(as(ownerToken))
    .send({ label: 'طاولة ٩', seats: 4 });
  tableId = table.body.id;
});

afterAll(async () => {
  await admin.$executeRaw`UPDATE public.reservations SET seated_order_id = NULL WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.reservations WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.restaurant_tables WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${waiterId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('sitting a party down', () => {
  let firstBooking = '';
  let firstOrder = '';

  it('opens a tab at the booking\'s table, in one call', async () => {
    firstBooking = await book('أحمد', 1);

    const res = await request(app)
      .post(`/api/reservations/${firstBooking}/seat`)
      .set(as(waiterToken));

    expect(res.status).toBe(200);
    expect(res.body.order_id).toBeTruthy();
    firstOrder = res.body.order_id;

    const [order] = await admin.$queryRaw<Array<{ table_id: string; status: string }>>`
      SELECT table_id, status FROM public.orders WHERE id = ${firstOrder}::uuid`;
    expect(order.table_id).toBe(tableId);
    expect(order.status).toBe('open');
  });

  it('marks the booking seated and links it to that tab', async () => {
    const [row] = await admin.$queryRaw<Array<{ status: string; seated_order_id: string }>>`
      SELECT status, seated_order_id FROM public.reservations WHERE id = ${firstBooking}::uuid`;
    expect(row.status).toBe('seated');
    expect(row.seated_order_id).toBe(firstOrder);
  });

  it('a second tap returns the SAME tab, not a second bill', async () => {
    const again = await request(app)
      .post(`/api/reservations/${firstBooking}/seat`)
      .set(as(waiterToken));

    expect(again.status).toBe(200);
    expect(again.body.order_id).toBe(firstOrder);

    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.orders
       WHERE table_id = ${tableId}::uuid AND status = 'open'`;
    expect(Number(row.count)).toBe(1);
  });

  it('THE RULE: a second party at an occupied table is a 409 that says why', async () => {
    const second = await book('سارة', 4);

    const res = await request(app)
      .post(`/api/reservations/${second}/seat`)
      .set(as(waiterToken));

    expect(res.status).toBe(409);
    // Its own code: "the table is busy" and "that booking is not waiting" are
    // different problems with different fixes.
    expect(res.body.code).toBe('table_occupied');
  });

  it('a cancelled booking is a 409 with the OTHER code', async () => {
    const cancelled = await book('خالد', 20);
    await request(app)
      .post(`/api/reservations/${cancelled}/status`)
      .set(as(waiterToken))
      .send({ status: 'cancelled' });

    // A free table, so the only reason to refuse is the booking itself.
    const free = await request(app)
      .post('/api/reservations/tables')
      .set(as(ownerToken))
      .send({ label: 'طاولة ١٠', seats: 2 });
    await admin.$executeRaw`
      UPDATE public.reservations SET table_id = ${free.body.id}::uuid
       WHERE id = ${cancelled}::uuid`;

    const res = await request(app)
      .post(`/api/reservations/${cancelled}/seat`)
      .set(as(waiterToken));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_seatable');
  });

  it('a booking that does not exist is a 404', async () => {
    const res = await request(app)
      .post(`/api/reservations/${randomUUID()}/seat`)
      .set(as(waiterToken));
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    expect((await request(app).post(`/api/reservations/${firstBooking}/seat`)).status).toBe(401);
  });
});
