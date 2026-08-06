import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Tables and bookings over HTTP (0039).
 *
 * The SQL suite proves the EXCLUDE constraint. What only this can prove is
 * that a host on the phone gets a sentence instead of a stack trace: "that
 * table is taken then" is a 409 they can act on, and a 500 is a lost booking.
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
const accountantId = randomUUID();

let ownerToken = '';
let waiterToken = '';
let accountantToken = '';
let tableId = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

/**
 * Every timestamp in this file is measured from ONE instant, fixed when the
 * module loads.
 *
 * Computing it from Date.now() per call drifts by milliseconds between calls,
 * and this suite tests boundaries: a sitting ending at `at(26)` and the next
 * starting at `at(26)` are only back-to-back if both mean the same moment.
 * With drift the first one ends slightly LATER than the second begins, the
 * exclusion constraint correctly refuses it, and the failure looks like a
 * product bug. It is not.
 */
const BASE = Date.now();
const at = (hoursFromBase: number) =>
  new Date(BASE + hoursFromBase * 3600_000).toISOString();

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Res Org'}, ${`res-${orgId.slice(0, 8)}`}, 'basic')`;

  for (const [id, prefix, role] of [
    [ownerId, 'res-own', 'owner'],
    [waiterId, 'res-wai', 'waiter'],
    [accountantId, 'res-acc', 'accountant'],
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
  accountantToken = sign(accountantId);

  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${orgId}::uuid, 'reservations', true)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.reservations WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.restaurant_tables WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${waiterId}::uuid, ${accountantId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('the floor plan', () => {
  it('a manager defines a table', async () => {
    const res = await request(app)
      .post('/api/reservations/tables')
      .set(as(ownerToken))
      .send({ label: 'طاولة ٧', area: 'الصالة', seats: 4 });

    expect(res.status).toBe(201);
    tableId = res.body.id;
  });

  it('two tables cannot share a label', async () => {
    const res = await request(app)
      .post('/api/reservations/tables')
      .set(as(ownerToken))
      .send({ label: 'طاولة ٧', seats: 2 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_label');
  });

  it('a waiter reads the floor plan but does not redraw it', async () => {
    const read = await request(app).get('/api/reservations/tables').set(as(waiterToken));
    expect(read.status).toBe(200);
    expect(read.body.length).toBeGreaterThan(0);

    const write = await request(app)
      .post('/api/reservations/tables')
      .set(as(waiterToken))
      .send({ label: 'طاولة النادل', seats: 2 });
    expect(write.status).toBe(403);
  });

  it('a table is retired, never deleted', async () => {
    const extra = await request(app)
      .post('/api/reservations/tables')
      .set(as(ownerToken))
      .send({ label: 'شرفة ٣', seats: 2 });

    const retire = await request(app)
      .patch(`/api/reservations/tables/${extra.body.id}`)
      .set(as(ownerToken))
      .send({ is_active: false });
    expect(retire.status).toBe(200);

    // Gone from the default list, still on record.
    const active = await request(app).get('/api/reservations/tables').set(as(ownerToken));
    expect(active.body.map((t: { id: string }) => t.id)).not.toContain(extra.body.id);

    const all = await request(app).get('/api/reservations/tables?all=true').set(as(ownerToken));
    expect(all.body.map((t: { id: string }) => t.id)).toContain(extra.body.id);
  });
});

describe('taking a booking', () => {
  it('a waiter takes one — answering the phone is floor work', async () => {
    const res = await request(app)
      .post('/api/reservations')
      .set(as(waiterToken))
      .send({
        table_id: tableId,
        guest_name: 'أحمد',
        guest_phone: '01000000000',
        party_size: 4,
        starts_at: at(24),
        ends_at: at(26),
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('THE RULE: the same table cannot be promised twice', async () => {
    const res = await request(app)
      .post('/api/reservations')
      .set(as(waiterToken))
      .send({ table_id: tableId, guest_name: 'سارة', party_size: 2, starts_at: at(25), ends_at: at(27) });

    // A sentence a host can act on while somebody is on the phone.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('double_booking');
  });

  it('back to back is fine', async () => {
    const res = await request(app)
      .post('/api/reservations')
      .set(as(waiterToken))
      .send({ table_id: tableId, guest_name: 'منى', party_size: 3, starts_at: at(26), ends_at: at(28) });

    expect(res.status).toBe(201);
  });

  it('an accountant may read the book but not write in it', async () => {
    const read = await request(app)
      .get(`/api/reservations?from=${at(0)}&to=${at(48)}`)
      .set(as(accountantToken));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post('/api/reservations')
      .set(as(accountantToken))
      .send({ table_id: tableId, guest_name: 'محاسب', party_size: 2, starts_at: at(30), ends_at: at(31) });
    expect(write.status).toBe(403);
  });

  it('demands a name and a sane party size', async () => {
    const noName = await request(app)
      .post('/api/reservations')
      .set(as(waiterToken))
      .send({ table_id: tableId, guest_name: '', party_size: 2, starts_at: at(40), ends_at: at(41) });
    expect(noName.status).toBe(400);

    const silly = await request(app)
      .post('/api/reservations')
      .set(as(waiterToken))
      .send({ table_id: tableId, guest_name: 'ضيف', party_size: 900, starts_at: at(40), ends_at: at(41) });
    expect(silly.status).toBe(400);
  });
});

describe('availability', () => {
  it('agrees with the constraint — free means the insert will work', async () => {
    const taken = await request(app)
      .get(`/api/reservations/availability?table_id=${tableId}&starts_at=${at(25)}&ends_at=${at(26)}`)
      .set(as(waiterToken));
    expect(taken.body.free).toBe(false);

    const free = await request(app)
      .get(`/api/reservations/availability?table_id=${tableId}&starts_at=${at(50)}&ends_at=${at(51)}`)
      .set(as(waiterToken));
    expect(free.body.free).toBe(true);

    // The claim is only worth anything if the insert then succeeds.
    const booked = await request(app)
      .post('/api/reservations')
      .set(as(waiterToken))
      .send({ table_id: tableId, guest_name: 'خالد', party_size: 2, starts_at: at(50), ends_at: at(51) });
    expect(booked.status).toBe(201);
  });
});

describe('what happened to the booking', () => {
  it('cancelling releases the table and keeps the record', async () => {
    const list = await request(app)
      .get(`/api/reservations?from=${at(0)}&to=${at(48)}`)
      .set(as(waiterToken));
    const ahmed = (list.body as Array<{ id: string; guest_name: string }>).find(
      (r) => r.guest_name === 'أحمد',
    )!;

    const cancel = await request(app)
      .post(`/api/reservations/${ahmed.id}/status`)
      .set(as(waiterToken))
      .send({ status: 'cancelled' });
    expect(cancel.status).toBe(200);

    // The slot is promisable again...
    const rebook = await request(app)
      .post('/api/reservations')
      .set(as(waiterToken))
      .send({ table_id: tableId, guest_name: 'بديل', party_size: 2, starts_at: at(24), ends_at: at(26) });
    expect(rebook.status).toBe(201);

    // ...and the cancellation is still countable. A restaurant that cannot see
    // its empty tables cannot do anything about them.
    const after = await request(app)
      .get(`/api/reservations?from=${at(0)}&to=${at(48)}`)
      .set(as(waiterToken));
    const stillThere = (after.body as Array<{ id: string; status: string }>).find(
      (r) => r.id === ahmed.id,
    );
    expect(stillThere?.status).toBe('cancelled');
  });

  it('refuses a status nobody defined', async () => {
    const list = await request(app)
      .get(`/api/reservations?from=${at(0)}&to=${at(48)}`)
      .set(as(waiterToken));
    const any = (list.body as Array<{ id: string }>)[0];

    const res = await request(app)
      .post(`/api/reservations/${any.id}/status`)
      .set(as(waiterToken))
      .send({ status: 'maybe' });
    expect(res.status).toBe(400);
  });
});

describe('the module gate', () => {
  it('switching reservations off answers 409, and the book survives', async () => {
    await admin.$executeRaw`
      UPDATE public.organization_modules SET enabled = false
       WHERE organization_id = ${orgId}::uuid AND module_key = 'reservations'`;

    const res = await request(app).get('/api/reservations/tables').set(as(ownerToken));
    expect(res.status).toBe(409);
    expect(res.body.module).toBe('reservations');

    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.reservations WHERE organization_id = ${orgId}::uuid`;
    expect(Number(row.count)).toBeGreaterThan(0);

    await admin.$executeRaw`
      UPDATE public.organization_modules SET enabled = true
       WHERE organization_id = ${orgId}::uuid AND module_key = 'reservations'`;
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/reservations/tables')).status).toBe(401);
    expect((await request(app).post('/api/reservations').send({})).status).toBe(401);
  });
});
