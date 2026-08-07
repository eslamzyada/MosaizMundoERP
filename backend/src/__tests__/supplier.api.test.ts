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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the supplier tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const flourId = randomUUID();

// A second tenant, with its own supplier, to prove attribution cannot cross.
const orgBId = randomUUID();
const userBId = randomUUID();
const supplierBId = randomUUID();

const tokens: Record<string, string> = {};

interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  is_active: boolean;
}
interface PriceRow {
  raw_item_id: string;
  raw_item_name: string;
  supplier_id: string;
  supplier_name: string;
  deliveries: number;
  min_cost: number;
  max_cost: number;
  latest_cost: number;
  previous_cost: number | null;
  total_spend: number;
}

async function createSupplier(
  body: Record<string, unknown>,
  who = 'owner',
): Promise<request.Response> {
  return request(app)
    .post('/api/suppliers')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send(body);
}

async function receive(
  body: Record<string, unknown>,
  who = 'owner',
): Promise<request.Response> {
  return request(app)
    .post('/api/inventory/receive')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send(body);
}

async function priceHistory(who = 'owner'): Promise<PriceRow[]> {
  const res = await request(app)
    .get('/api/suppliers/price-history')
    .set('Authorization', `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body as PriceRow[];
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Supplier Org'}, ${`sup-${orgId.slice(0, 8)}`}, 'enterprise')`;
  for (const [id, label, role] of [
    [ownerId, 'sup-owner', 'owner'],
    [cashierId, 'sup-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${flourId}::uuid, ${orgId}::uuid, ${'Sup Flour'}, ${'grams'})`;

  // Tenant B and its supplier.
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Supplier Org B'}, ${`sup-b-${userBId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`sup-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${supplierBId}::uuid, ${orgBId}::uuid, ${'Tenant B Supplier'})`;
  tokens.ownerB = jwt.sign(
    { sub: userBId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Suppliers API', () => {
  test('an admin creates a supplier; a duplicate name is 409', async () => {
    const res = await createSupplier({ name: 'Cairo Foods', phone: '+20 100' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Cairo Foods');
    expect(res.body.is_active).toBe(true);

    // Two records for one supplier would split its price history in half.
    const dup = await createSupplier({ name: 'Cairo Foods' });
    expect(dup.status).toBe(409);
  });

  test('a cashier may read suppliers but not create or change one', async () => {
    const read = await request(app)
      .get('/api/suppliers')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(read.status).toBe(200);
    expect((read.body as Supplier[]).some((s) => s.name === 'Cairo Foods')).toBe(true);

    expect((await createSupplier({ name: 'Rogue' }, 'cashier')).status).toBe(403);

    const [existing] = (await request(app)
      .get('/api/suppliers')
      .set('Authorization', `Bearer ${tokens.owner}`)).body as Supplier[];
    const patch = await request(app)
      .patch(`/api/suppliers/${existing.id}`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ name: 'Renamed By Cashier' });
    expect(patch.status).toBe(403);
  });

  test('receiving stock records who supplied it', async () => {
    const [supplier] = (await request(app)
      .get('/api/suppliers')
      .set('Authorization', `Bearer ${tokens.owner}`)).body as Supplier[];

    const res = await receive({
      raw_item_id: flourId,
      quantity_received: 100,
      cost_at_purchase: 0.15,
      supplier_id: supplier.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.supplier_id).toBe(supplier.id);
  });

  test('attribution is optional — a lot with no supplier is still accepted', async () => {
    // Found stock and pre-0020 deliveries genuinely have no supplier; blocking
    // them would push users into inventing one.
    const res = await receive({
      raw_item_id: flourId,
      quantity_received: 40,
      cost_at_purchase: 0.11,
    });
    expect(res.status).toBe(201);
    expect(res.body.supplier_id).toBeNull();
  });

  test("a lot cannot be attributed to another tenant's supplier", async () => {
    const res = await receive({
      raw_item_id: flourId,
      quantity_received: 10,
      cost_at_purchase: 1.0,
      supplier_id: supplierBId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Supplier not found/i);

    // Nothing was written.
    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.inventory_batches WHERE supplier_id = ${supplierBId}::uuid`;
    expect(rows.length).toBe(0);
  });

  test('a malformed supplier_id is rejected before touching the database', async () => {
    const res = await receive({
      raw_item_id: flourId,
      quantity_received: 5,
      cost_at_purchase: 1.0,
      supplier_id: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
  });

  test('price history answers "did they put the price up?"', async () => {
    const [supplier] = (await request(app)
      .get('/api/suppliers')
      .set('Authorization', `Bearer ${tokens.owner}`)).body as Supplier[];

    // A dearer second delivery from the same supplier, later than the first.
    await admin.$executeRaw`
      INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining,
         cost_at_purchase, supplier_id, received_at)
      VALUES (${orgId}::uuid, ${flourId}::uuid, 200, 200, 0.19, ${supplier.id}::uuid,
              now() + interval '1 hour')`;

    const rows = await priceHistory();
    const row = rows.find((r) => r.supplier_id === supplier.id && r.raw_item_id === flourId)!;

    expect(row.supplier_name).toBe('Cairo Foods');
    expect(row.raw_item_name).toBe('Sup Flour');
    expect(row.deliveries).toBe(2);
    expect(Number(row.latest_cost)).toBeCloseTo(0.19, 6);
    expect(Number(row.previous_cost)).toBeCloseTo(0.15, 6);
    expect(Number(row.min_cost)).toBeCloseTo(0.15, 6);
    expect(Number(row.max_cost)).toBeCloseTo(0.19, 6);
    // 100 x 0.15 + 200 x 0.19 = 53.00
    expect(Number(row.total_spend)).toBeCloseTo(53, 6);
  });

  test('unattributed lots are excluded, not smeared across suppliers', async () => {
    const rows = await priceHistory();
    // The 40 units at 0.11 had no supplier. If it leaked in, min_cost would
    // drop to 0.11 and deliveries would be 3.
    const row = rows.find((r) => r.raw_item_id === flourId)!;
    expect(row.deliveries).toBe(2);
    expect(Number(row.min_cost)).toBeCloseTo(0.15, 6);
  });

  test('deactivating retires a supplier without losing its history', async () => {
    const [supplier] = (await request(app)
      .get('/api/suppliers')
      .set('Authorization', `Bearer ${tokens.owner}`)).body as Supplier[];

    const res = await request(app)
      .patch(`/api/suppliers/${supplier.id}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);

    // The whole reason there is no delete: past purchases keep their name.
    const rows = await priceHistory();
    const row = rows.find((r) => r.supplier_id === supplier.id)!;
    expect(row).toBeDefined();
    expect(row.supplier_name).toBe('Cairo Foods');
    expect(row.deliveries).toBe(2);

    // Put it back for any later run.
    await request(app)
      .patch(`/api/suppliers/${supplier.id}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ is_active: true });
  });

  test("another tenant's suppliers and prices are invisible", async () => {
    const list = await request(app)
      .get('/api/suppliers')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect((list.body as Supplier[]).some((s) => s.id === supplierBId)).toBe(false);

    const rows = await priceHistory('ownerB');
    expect(rows.every((r) => r.raw_item_id !== flourId)).toBe(true);
  });

  test('a nonexistent supplier is 404, and an empty patch is 400', async () => {
    expect(
      (await request(app)
        .patch(`/api/suppliers/${randomUUID()}`)
        .set('Authorization', `Bearer ${tokens.owner}`)
        .send({ name: 'Ghost' })).status,
    ).toBe(404);

    const [supplier] = (await request(app)
      .get('/api/suppliers')
      .set('Authorization', `Bearer ${tokens.owner}`)).body as Supplier[];
    expect(
      (await request(app)
        .patch(`/api/suppliers/${supplier.id}`)
        .set('Authorization', `Bearer ${tokens.owner}`)
        .send({})).status,
    ).toBe(400);

    expect((await createSupplier({ name: '   ' })).status).toBe(400);
  });

  test('unauthenticated requests are rejected with 401', async () => {
    expect((await request(app).get('/api/suppliers')).status).toBe(401);
    expect((await request(app).get('/api/suppliers/price-history')).status).toBe(401);
  });
});
