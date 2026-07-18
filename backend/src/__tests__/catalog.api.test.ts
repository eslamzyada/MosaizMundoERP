import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

// Catalog (menu item) management: create / rename / re-price, admin-only.

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the catalog tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();

// A second tenant + its item, for the cross-tenant isolation test.
const orgBId = randomUUID();
const userBId = randomUUID();
const itemBId = randomUUID();

const tokens: Record<string, string> = {};

function sign(userId: string): string {
  return jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Catalog Org'}, ${`cat-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'cat-owner', 'owner'],
    [cashierId, 'cat-cashier', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = sign(id);
  }

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Catalog Org B'}, ${`cat-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`cat-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${itemBId}::uuid, ${orgBId}::uuid, ${'Tenant B Item'}, 9.99)`;
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Catalog: creating menu items (admin-only)', () => {
  let createdId: string;

  test('owner creates an item with a price (201), and it comes back priced', async () => {
    const res = await request(app)
      .post('/api/catalog/items')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ name: 'Shawarma', price: 75, sku: 'SHW-1' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Shawarma');
    expect(res.body.organization_id).toBe(orgId);
    expect(typeof res.body.price).toBe('number');
    expect(res.body.price).toBe(75);
    createdId = res.body.id;
  });

  test('the new item appears in the catalog list and the POS menu, priced', async () => {
    const list = await request(app)
      .get('/api/catalog/items')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(list.status).toBe(200);
    const inList = list.body.find((i: { id: string }) => i.id === createdId);
    expect(inList).toBeDefined();
    expect(inList.price).toBe(75);

    const menu = await request(app)
      .get('/api/pos/menu')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(menu.body.some((i: { id: string }) => i.id === createdId)).toBe(true);
  });

  test('owner re-prices the item (200)', async () => {
    const res = await request(app)
      .patch(`/api/catalog/items/${createdId}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ price: 80 });
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(80);
  });

  test('a cashier cannot create an item (403)', async () => {
    const res = await request(app)
      .post('/api/catalog/items')
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ name: 'Sneaky Free Item', price: 0 });
    expect(res.status).toBe(403);
  });

  test('a cashier cannot re-price an item (403), and the price is unchanged', async () => {
    const res = await request(app)
      .patch(`/api/catalog/items/${createdId}`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ price: 1 });
    expect(res.status).toBe(403);

    const rows = await admin.$queryRaw<Array<{ price: unknown }>>`
      SELECT price FROM public.sellable_items WHERE id = ${createdId}::uuid`;
    expect(Number(rows[0].price)).toBe(80);
  });

  test('a negative price is rejected (400)', async () => {
    const res = await request(app)
      .post('/api/catalog/items')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ name: 'Bad Price', price: -5 });
    expect(res.status).toBe(400);
  });

  test('a missing name is rejected (400)', async () => {
    const res = await request(app)
      .post('/api/catalog/items')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ price: 10 });
    expect(res.status).toBe(400);
  });

  test("cannot update another tenant's item (404), and it is unchanged", async () => {
    const res = await request(app)
      .patch(`/api/catalog/items/${itemBId}`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ price: 0.01 });
    expect(res.status).toBe(404);

    const rows = await admin.$queryRaw<Array<{ price: unknown }>>`
      SELECT price FROM public.sellable_items WHERE id = ${itemBId}::uuid`;
    expect(Number(rows[0].price)).toBe(9.99);
  });

  test('unauthenticated create is rejected (401)', async () => {
    const res = await request(app).post('/api/catalog/items').send({ name: 'X', price: 1 });
    expect(res.status).toBe(401);
  });
});
