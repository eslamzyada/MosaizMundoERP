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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the POS menu tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();

// Dishes covering each availability case.
const burgerId = randomUUID(); // two ingredients; the scarcer one binds
const drinkId = randomUUID(); // no recipe at all
const stewId = randomUUID(); // an ingredient is completely out
const orgBId = randomUUID();
const userBId = randomUUID();

const pattyId = randomUUID();
const bunId = randomUUID();
const lentilId = randomUUID();

const tokens: Record<string, string> = {};

interface MenuItem {
  id: string;
  name: string;
  price: number;
  portions_available: number | null;
}

async function menu(who = 'cashier'): Promise<MenuItem[]> {
  const res = await request(app)
    .get('/api/pos/menu')
    .set('Authorization', `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body as MenuItem[];
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Menu Org'}, ${`menu-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'menu-owner', 'owner'],
    [cashierId, 'menu-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  for (const [id, name, price] of [
    [burgerId, 'Menu Burger', 50],
    [drinkId, 'Menu Drink', 10],
    [stewId, 'Menu Stew', 40],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${id}::uuid, ${orgId}::uuid, ${name}, ${price})`;
  }
  for (const [id, name] of [
    [pattyId, 'Menu Patty'],
    [bunId, 'Menu Bun'],
    [lentilId, 'Menu Lentil'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${id}::uuid, ${orgId}::uuid, ${name}, ${'pieces'})`;
  }

  // Burger = 1 patty + 2 buns. Stock: 10 patties, 7 buns.
  //   patties allow 10; buns allow floor(7/2) = 3. The BUN binds -> 3 portions.
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${burgerId}::uuid, ${pattyId}::uuid, 1)`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${burgerId}::uuid, ${bunId}::uuid, 2)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${pattyId}::uuid, 10, 10, 1)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${bunId}::uuid, 7, 7, 1)`;

  // Stew needs lentils, which are entirely out.
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${stewId}::uuid, ${lentilId}::uuid, 100)`;

  // Menu Drink deliberately gets no recipe.

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Menu Org B'}, ${`menu-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`menu-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  tokens.ownerB = jwt.sign(
    { sub: userBId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_deficits WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('POS menu availability', () => {
  test('the scarcest ingredient decides how many portions are left', async () => {
    const burger = (await menu()).find((i) => i.id === burgerId)!;
    // 10 patties would allow 10, but 7 buns at 2 each allow only 3.
    expect(burger.portions_available).toBe(3);
  });

  test('a dish with an ingredient at zero shows none available', async () => {
    const stew = (await menu()).find((i) => i.id === stewId)!;
    expect(stew.portions_available).toBe(0);
  });

  test('a dish with no recipe is unconstrained, not zero', async () => {
    const drink = (await menu()).find((i) => i.id === drinkId)!;
    // Nothing tracked limits it. Reporting 0 would grey out every drink and
    // side that has never been given a recipe.
    expect(drink.portions_available).toBeNull();
  });

  test('the menu still carries what a till needs to ring up a sale', async () => {
    const burger = (await menu()).find((i) => i.id === burgerId)!;
    expect(burger.name).toBe('Menu Burger');
    expect(Number(burger.price)).toBeCloseTo(50, 6);
  });

  test('availability follows sales', async () => {
    // Ring up two burgers: 4 buns go, leaving 3 -> only 1 portion possible.
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({
        organization_id: orgId,
        client_offline_id: randomUUID(),
        items: [{ sellable_item_id: burgerId, quantity: 2 }],
      });
    expect(res.status).toBe(200);

    const burger = (await menu()).find((i) => i.id === burgerId)!;
    expect(burger.portions_available).toBe(1);
  });

  test('it is ADVISORY: a sale beyond availability still succeeds', async () => {
    // Only 1 portion is possible, but the POS may be offline with a stale
    // figure — refusing here would block a real sale at the till. The server
    // records the shortfall as a deficit instead, which is the honest response.
    const res = await request(app)
      .post('/api/pos/checkout')
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({
        organization_id: orgId,
        client_offline_id: randomUUID(),
        items: [{ sellable_item_id: burgerId, quantity: 5 }],
      });
    expect(res.status).toBe(200);

    const deficits = await admin.$queryRaw<Array<{ missing_quantity: unknown }>>`
      SELECT missing_quantity FROM public.inventory_deficits
      WHERE organization_id = ${orgId}::uuid AND raw_item_id = ${bunId}::uuid`;
    expect(deficits.length).toBe(1);
    // 5 burgers wanted 10 buns; 3 remained, so 7 were sold beyond stock.
    expect(Number(deficits[0].missing_quantity)).toBeCloseTo(7, 6);
  });

  test('a cashier may read the menu — it is their core job', async () => {
    const res = await request(app)
      .get('/api/pos/menu')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(res.status).toBe(200);
  });

  test("another tenant's menu is invisible", async () => {
    const rows = await menu('ownerB');
    expect(rows.every((i) => i.id !== burgerId)).toBe(true);
  });

  test('unauthenticated request is rejected with 401', async () => {
    expect((await request(app).get('/api/pos/menu')).status).toBe(401);
  });
});

describe('Food cost is not exposed to the till', () => {
  test('a cashier gets recipes WITHOUT any costing', async () => {
    const res = await request(app)
      .get('/api/recipes')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(res.status).toBe(200);

    const burger = (res.body as Array<Record<string, unknown>>).find((r) => r.id === burgerId)!;
    // The recipe itself is operational knowledge and stays visible...
    expect(Array.isArray(burger.bill_of_materials)).toBe(true);
    expect((burger.bill_of_materials as unknown[]).length).toBe(2);

    // ...but the money does not. #45 restricted profitability to FINANCE_ROLES
    // for this exact reason; this endpoint started returning costs in #42
    // without a matching gate.
    expect(burger.total_cost).toBeUndefined();
    expect(burger.uncosted_line_count).toBeUndefined();
    for (const line of burger.bill_of_materials as Array<Record<string, unknown>>) {
      expect(line.unit_cost).toBeUndefined();
      expect(line.line_cost).toBeUndefined();
    }
  });

  test('an owner still gets the costs they need to price a menu', async () => {
    const res = await request(app)
      .get('/api/recipes')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);

    const burger = (res.body as Array<Record<string, unknown>>).find((r) => r.id === burgerId)!;
    expect(typeof burger.total_cost).toBe('number');
    expect(typeof burger.uncosted_line_count).toBe('number');
  });
});
