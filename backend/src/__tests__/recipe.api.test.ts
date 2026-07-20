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
const cashierId = randomUUID();
const orgId = randomUUID();
const burgerId = randomUUID();
const pattyId = randomUUID();
const bunId = randomUUID();

// A second tenant, to prove a recipe line cannot be reached across orgs.
const otherOrgId = randomUUID();
const otherUserId = randomUUID();
const otherSellableId = randomUUID();
const otherRawId = randomUUID();
const otherLineId = randomUUID();

let token: string;
let cashierToken: string;

/** The current recipe lines of the fixture burger, as the owner sees them. */
async function burgerLines(): Promise<
  Array<{ id: string; raw_item_id: string; quantity_required: number }>
> {
  const res = await request(app).get('/api/recipes').set('Authorization', `Bearer ${token}`);
  const burger = res.body.find((s: { id: string }) => s.id === burgerId);
  return burger.bill_of_materials;
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`rec-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Recipe Org'}, ${`rec-${userId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku) VALUES (${burgerId}::uuid, ${orgId}::uuid, ${'Burger'}, ${'REC-BRG'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${pattyId}::uuid, ${orgId}::uuid, ${'Patty'}, ${'pieces'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${bunId}::uuid, ${orgId}::uuid, ${'Bun'}, ${'pieces'})`;
  // One existing recipe line: Burger needs 1 Patty.
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${burgerId}::uuid, ${pattyId}::uuid, 1)`;

  // A cashier in the SAME org: recipes are readable but not editable by them.
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${cashierId}::uuid, ${`rec-cash-${cashierId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${cashierId}::uuid, 'cashier')`;

  // A second tenant with its own recipe line.
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${otherUserId}::uuid, ${`rec-other-${otherUserId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${otherOrgId}::uuid, ${'Other Recipe Org'}, ${`rec-oth-${otherUserId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${otherOrgId}::uuid, ${otherUserId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku) VALUES (${otherSellableId}::uuid, ${otherOrgId}::uuid, ${'Other Dish'}, ${'REC-OTH'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${otherRawId}::uuid, ${otherOrgId}::uuid, ${'Other Spice'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (id, organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${otherLineId}::uuid, ${otherOrgId}::uuid, ${otherSellableId}::uuid, ${otherRawId}::uuid, 7)`;

  token = jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
  cashierToken = jwt.sign(
    { sub: cashierId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${userId}::uuid, ${cashierId}::uuid, ${otherUserId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
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
    // Price column (migration 0008) surfaces as a JSON number, defaulting to 0.
    expect(typeof burger.price).toBe('number');
    expect(burger.price).toBe(0);
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

  test('POST the same ingredient twice returns 409, not a 500', async () => {
    const res = await request(app)
      .post(`/api/recipes/${burgerId}/lines`)
      .set('Authorization', `Bearer ${token}`)
      .send({ raw_item_id: bunId, quantity_required: 3 });
    expect(res.status).toBe(409);
  });

  test('POST an ingredient from another organization returns 400', async () => {
    const res = await request(app)
      .post(`/api/recipes/${burgerId}/lines`)
      .set('Authorization', `Bearer ${token}`)
      .send({ raw_item_id: otherRawId, quantity_required: 1 });
    expect(res.status).toBe(400);
  });

  test('PATCH /api/recipes/lines/:lineId changes the quantity (200)', async () => {
    const line = (await burgerLines()).find((l) => l.raw_item_id === bunId);
    expect(line).toBeDefined();

    const res = await request(app)
      .patch(`/api/recipes/lines/${line!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity_required: 5 });
    expect(res.status).toBe(200);

    const after = (await burgerLines()).find((l) => l.raw_item_id === bunId);
    expect(after!.quantity_required).toBe(5);
  });

  test('PATCH rejects a non-positive quantity with 400', async () => {
    const line = (await burgerLines()).find((l) => l.raw_item_id === bunId);
    for (const bad of [0, -2, 'two']) {
      const res = await request(app)
        .patch(`/api/recipes/lines/${line!.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quantity_required: bad });
      expect(res.status).toBe(400);
    }
    // The quantity set by the previous test is untouched.
    const after = (await burgerLines()).find((l) => l.raw_item_id === bunId);
    expect(after!.quantity_required).toBe(5);
  });

  test("PATCH on another tenant's line is 404 and leaves that line intact", async () => {
    const res = await request(app)
      .patch(`/api/recipes/lines/${otherLineId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity_required: 99 });
    expect(res.status).toBe(404);

    const [row] = await admin.$queryRaw<Array<{ quantity_required: string }>>`
      SELECT quantity_required FROM public.bill_of_materials WHERE id = ${otherLineId}::uuid`;
    expect(Number(row.quantity_required)).toBe(7);
  });

  test('a cashier may read a recipe but not edit or remove a line (403)', async () => {
    const read = await request(app)
      .get('/api/recipes')
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(read.status).toBe(200);

    const line = (await burgerLines()).find((l) => l.raw_item_id === bunId);

    const patch = await request(app)
      .patch(`/api/recipes/lines/${line!.id}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ quantity_required: 999 });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/recipes/lines/${line!.id}`)
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(del.status).toBe(403);

    // Refused, and nothing changed.
    const after = (await burgerLines()).find((l) => l.raw_item_id === bunId);
    expect(after).toBeDefined();
    expect(after!.quantity_required).toBe(5);
  });

  test("DELETE another tenant's line is 404 and does not remove it", async () => {
    const res = await request(app)
      .delete(`/api/recipes/lines/${otherLineId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);

    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.bill_of_materials WHERE id = ${otherLineId}::uuid`;
    expect(rows.length).toBe(1);
  });

  test('DELETE /api/recipes/lines/:lineId removes the line (204)', async () => {
    const line = (await burgerLines()).find((l) => l.raw_item_id === bunId);

    const res = await request(app)
      .delete(`/api/recipes/lines/${line!.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const after = await burgerLines();
    expect(after.some((l) => l.raw_item_id === bunId)).toBe(false);
    // The other ingredient of the recipe is still there.
    expect(after.some((l) => l.raw_item_id === pattyId)).toBe(true);

    // Removing a line is not retroactive — deleting it again is simply gone.
    const again = await request(app)
      .delete(`/api/recipes/lines/${line!.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(404);
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/recipes');
    expect(res.status).toBe(401);
  });
});
