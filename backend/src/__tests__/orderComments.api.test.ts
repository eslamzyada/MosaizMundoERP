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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the order comment tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const cashierId = randomUUID();
const dishId = randomUUID();
let token = '';

async function checkout(body: Record<string, unknown>) {
  return request(app)
    .post('/api/pos/checkout')
    .set('Authorization', `Bearer ${token}`)
    .send({ organization_id: orgId, client_offline_id: randomUUID(), ...body });
}

async function orderFor(clientOfflineId: string) {
  const [row] = await admin.$queryRaw<Array<{ id: string; note: string | null }>>`
    SELECT id, note FROM public.orders WHERE client_offline_id = ${clientOfflineId}::uuid`;
  return row;
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Note Org'}, ${`note-${orgId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${cashierId}::uuid, ${`note-${cashierId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${cashierId}::uuid, 'cashier')`;
  token = jwt.sign(
    { sub: cashierId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${dishId}::uuid, ${orgId}::uuid, ${'برجر لحم'}, ${'NOTE-1'}, 50)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.inventory_consumption WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${cashierId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Comments through the checkout endpoint', () => {
  test('an order note and a line note both reach the database', async () => {
    const coid = randomUUID();
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({
        organization_id: orgId,
        client_offline_id: coid,
        note: 'طاولة ٥ — حساسية مكسرات',
        items: [{ sellable_item_id: dishId, quantity: 1, note: 'بدون بصل' }],
      });
    expect(res.status).toBe(200);

    const order = await orderFor(coid);
    // Arabic must survive the whole path: JSON body -> jsonb -> text column.
    expect(order.note).toBe('طاولة ٥ — حساسية مكسرات');

    const [line] = await admin.$queryRaw<Array<{ note: string | null }>>`
      SELECT note FROM public.order_items WHERE order_id = ${order.id}::uuid`;
    expect(line.note).toBe('بدون بصل');
  });

  test('the same dish with two different notes stays two lines', async () => {
    // The failure this prevents is not cosmetic: merging them discards one
    // instruction, and the one that disappears could be the allergy.
    const coid = randomUUID();
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({
        organization_id: orgId,
        client_offline_id: coid,
        items: [
          { sellable_item_id: dishId, quantity: 1, note: 'بدون بصل' },
          { sellable_item_id: dishId, quantity: 1, note: 'حار جدًا' },
        ],
      });
    expect(res.status).toBe(200);

    const order = await orderFor(coid);
    const lines = await admin.$queryRaw<Array<{ note: string }>>`
      SELECT note FROM public.order_items WHERE order_id = ${order.id}::uuid ORDER BY note`;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.note).sort()).toEqual(['بدون بصل', 'حار جدًا'].sort());
  });

  test('a checkout with no notes at all still works', async () => {
    // Every till built before this migration keeps working unchanged.
    const coid = randomUUID();
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({
        organization_id: orgId,
        client_offline_id: coid,
        items: [{ sellable_item_id: dishId, quantity: 2 }],
      });
    expect(res.status).toBe(200);
    expect((await orderFor(coid)).note).toBeNull();
  });

  test('a blank note is stored as absent, not as an empty string', async () => {
    const coid = randomUUID();
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({
        organization_id: orgId,
        client_offline_id: coid,
        note: '   ',
        items: [{ sellable_item_id: dishId, quantity: 1, note: '' }],
      });
    expect(res.status).toBe(200);

    const order = await orderFor(coid);
    expect(order.note).toBeNull();
    const [line] = await admin.$queryRaw<Array<{ note: string | null }>>`
      SELECT note FROM public.order_items WHERE order_id = ${order.id}::uuid`;
    expect(line.note).toBeNull();
  });

  test('an over-long note is refused rather than truncated', async () => {
    // Silently trimming would drop the end of an instruction, and the end is
    // where "no nuts" tends to be.
    const res = await checkout({
      note: 'x'.repeat(501),
      items: [{ sellable_item_id: dishId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });

  test('the notes come back on the order history the till reads', async () => {
    const res = await request(app)
      .get('/api/pos/orders')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const withNote = (res.body as Array<{ note: string | null }>).find(
      (o) => o.note === 'طاولة ٥ — حساسية مكسرات',
    );
    expect(withNote).toBeDefined();
  });
});
