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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the recipe tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const userId = randomUUID();
const orgId = randomUUID();
const burgerId = randomUUID();
const pattyId = randomUUID();
const bunId = randomUUID();

let token: string;

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`rec-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Recipe Org'}, ${`rec-${userId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku) VALUES (${burgerId}::uuid, ${orgId}::uuid, ${'Burger'}, ${'REC-BRG'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${pattyId}::uuid, ${orgId}::uuid, ${'Patty'}, ${'pieces'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${bunId}::uuid, ${orgId}::uuid, ${'Bun'}, ${'pieces'})`;
  // One existing recipe line: Burger needs 1 Patty.
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${burgerId}::uuid, ${pattyId}::uuid, 1)`;

  token = jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${userId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Recipes API', () => {
  test('GET /api/recipes returns 200 with nested bill_of_materials + raw items', async () => {
    const res = await request(app)
      .get('/api/recipes')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const burger = res.body.find((s: { id: string }) => s.id === burgerId);
    expect(burger).toBeDefined();
    expect(Array.isArray(burger.bill_of_materials)).toBe(true);
    expect(burger.bill_of_materials.length).toBe(1);
    expect(burger.bill_of_materials[0].raw_inventory_items.name).toBe('Patty');
    // Decimal serialized as a number.
    expect(typeof burger.bill_of_materials[0].quantity_required).toBe('number');
  });

  test('POST /api/recipes/:id/lines adds a line (201) and appears on next GET', async () => {
    const add = await request(app)
      .post(`/api/recipes/${burgerId}/lines`)
      .set('Authorization', `Bearer ${token}`)
      .send({ raw_item_id: bunId, quantity_required: 2 });
    expect(add.status).toBe(201);

    const res = await request(app)
      .get('/api/recipes')
      .set('Authorization', `Bearer ${token}`);
    const burger = res.body.find((s: { id: string }) => s.id === burgerId);
    expect(burger.bill_of_materials.length).toBe(2);
    expect(
      burger.bill_of_materials.some(
        (l: { raw_item_id: string }) => l.raw_item_id === bunId,
      ),
    ).toBe(true);
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/recipes');
    expect(res.status).toBe(401);
  });
});
