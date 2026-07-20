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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the catalog cost tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const userId = randomUUID();
const orgId = randomUUID();

const pricedId = randomUUID(); // complete recipe
const bareId = randomUUID(); // no recipe at all
const partialId = randomUUID(); // one ingredient unpriceable
const riceId = randomUUID();
const herbId = randomUUID(); // never stocked

let token: string;

type Item = {
  id: string;
  name: string;
  price: number;
  total_cost: number;
  uncosted_line_count: number;
  recipe_line_count: number;
};

async function fetchItems(): Promise<Item[]> {
  const res = await request(app)
    .get('/api/catalog/items')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as Item[];
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`catcost-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Catalog Cost Org'}, ${`catcost-${userId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${pricedId}::uuid, ${orgId}::uuid, ${'Priced Dish'}, ${'CC-PRICED'}, 100)`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${bareId}::uuid, ${orgId}::uuid, ${'Bare Dish'}, ${'CC-BARE'}, 50)`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${partialId}::uuid, ${orgId}::uuid, ${'Partial Dish'}, ${'CC-PARTIAL'}, 80)`;

  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${riceId}::uuid, ${orgId}::uuid, ${'CC Rice'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${herbId}::uuid, ${orgId}::uuid, ${'CC Herb'}, ${'grams'})`;

  // Rice: 20 remaining at 2.50 each.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${riceId}::uuid, 20, 20, 2.50)`;
  // Herb: never stocked.

  // Priced Dish = 2 rice -> 5.00 of a 100.00 price.
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${pricedId}::uuid, ${riceId}::uuid, 2)`;
  // Partial Dish = 1 rice + 1 herb -> only the rice can be priced.
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${partialId}::uuid, ${riceId}::uuid, 1)`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${partialId}::uuid, ${herbId}::uuid, 3)`;
  // Bare Dish: no recipe rows at all.

  token = jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${userId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Menu item cost and margin', () => {
  test('a fully costed item reports its food cost against its price', async () => {
    const item = (await fetchItems()).find((i) => i.id === pricedId)!;

    expect(item.total_cost).toBeCloseTo(5, 6); // 2 x 2.50
    expect(item.uncosted_line_count).toBe(0);
    expect(item.recipe_line_count).toBe(1);
    expect(item.price).toBe(100); // so the UI can show 5% food cost
  });

  test('an item with NO recipe is distinguishable from one that costs nothing', async () => {
    const bare = (await fetchItems()).find((i) => i.id === bareId)!;

    // total_cost is 0 here only because there is nothing to add up. The caller
    // must key off recipe_line_count, or a brand-new item would look like pure
    // profit at a 100% margin.
    expect(bare.recipe_line_count).toBe(0);
    expect(bare.uncosted_line_count).toBe(0);
    expect(bare.total_cost).toBe(0);

    // The contrast that matters: a real recipe also totalling a small number
    // still reports its lines, so the two states never look alike.
    const priced = (await fetchItems()).find((i) => i.id === pricedId)!;
    expect(priced.recipe_line_count).toBeGreaterThan(0);
  });

  test('an item with an unstocked ingredient is flagged partial, not cheap', async () => {
    const item = (await fetchItems()).find((i) => i.id === partialId)!;

    expect(item.total_cost).toBeCloseTo(2.5, 6); // the rice only
    expect(item.uncosted_line_count).toBe(1); // the herb
    expect(item.recipe_line_count).toBe(2);
  });

  test('the menu and the recipe editor report the SAME cost for the same item', async () => {
    // The whole reason the costing basis lives in lib/foodCost: if these two
    // endpoints ever diverge, the owner has two numbers and no way to choose.
    const items = await fetchItems();
    const recipesRes = await request(app)
      .get('/api/recipes')
      .set('Authorization', `Bearer ${token}`);
    expect(recipesRes.status).toBe(200);

    const recipes = recipesRes.body as Array<{
      id: string;
      total_cost: number;
      uncosted_line_count: number;
    }>;

    for (const item of items) {
      const recipe = recipes.find((r) => r.id === item.id)!;
      expect(recipe).toBeDefined();
      expect(item.total_cost).toBeCloseTo(recipe.total_cost, 6);
      expect(item.uncosted_line_count).toBe(recipe.uncosted_line_count);
    }
  });

  test('cost follows stock: draining the rice leaves every dish that uses it unpriced', async () => {
    await admin.$executeRaw`UPDATE public.inventory_batches SET quantity_remaining = 0 WHERE raw_item_id = ${riceId}::uuid`;

    const items = await fetchItems();
    const priced = items.find((i) => i.id === pricedId)!;
    const partial = items.find((i) => i.id === partialId)!;

    expect(priced.uncosted_line_count).toBe(1);
    expect(priced.total_cost).toBe(0); // a floor of zero, with a line unpriced
    expect(partial.uncosted_line_count).toBe(2);

    await admin.$executeRaw`UPDATE public.inventory_batches SET quantity_remaining = quantity_received WHERE raw_item_id = ${riceId}::uuid`;
  });
});
