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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the recipe cost tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const userId = randomUUID();
const orgId = randomUUID();

const stewId = randomUUID(); // has an uncosted ingredient
const pilafId = randomUUID(); // fully costed
const riceId = randomUUID(); // two open lots at different costs
const herbId = randomUUID(); // never stocked at all
const spiceId = randomUUID(); // stocked once, now fully consumed

let token: string;

type Line = {
  raw_item_id: string;
  quantity_required: number;
  unit_cost: number | null;
  line_cost: number | null;
};
type Dish = {
  id: string;
  total_cost: number;
  uncosted_line_count: number;
  bill_of_materials: Line[];
};

async function fetchDishes(): Promise<Dish[]> {
  const res = await request(app).get('/api/recipes').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as Dish[];
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`cost-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Cost Org'}, ${`cost-${userId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${stewId}::uuid, ${orgId}::uuid, ${'Cost Stew'}, ${'COST-STW'}, 40)`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${pilafId}::uuid, ${orgId}::uuid, ${'Cost Pilaf'}, ${'COST-PLF'}, 30)`;

  for (const [id, name] of [
    [riceId, 'Cost Rice'],
    [herbId, 'Cost Herb'],
    [spiceId, 'Cost Spice'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${id}::uuid, ${orgId}::uuid, ${name}, ${'grams'})`;
  }

  // Rice: 10 remaining @ 3.00 and 30 remaining @ 5.00.
  //   weighted average = (10*3 + 30*5) / 40 = 180 / 40 = 4.50
  // A plain average of the two lot prices would be 4.00 — the assertions below
  // would catch that mistake.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${riceId}::uuid, 10, 10, 3.00)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${riceId}::uuid, 30, 30, 5.00)`;
  // A fully consumed lot at an absurd price: it must not move the average.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${riceId}::uuid, 5, 0, 99.00)`;

  // Spice: bought once, entirely consumed. Every lot is at zero, so there is no
  // cost basis — and, critically, no division by zero.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${spiceId}::uuid, 8, 0, 7.00)`;

  // Herb: never stocked at all — no lots whatsoever.

  // Stew = 2 rice + 5 herb + 1 spice  (only the rice can be priced)
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${stewId}::uuid, ${riceId}::uuid, 2)`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${stewId}::uuid, ${herbId}::uuid, 5)`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${stewId}::uuid, ${spiceId}::uuid, 1)`;

  // Pilaf = 3 rice  (fully costed)
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${pilafId}::uuid, ${riceId}::uuid, 3)`;

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

describe('Recipe food cost', () => {
  test('unit cost is the weighted average of open lots, not a plain average', async () => {
    const pilaf = (await fetchDishes()).find((d) => d.id === pilafId)!;
    const rice = pilaf.bill_of_materials.find((l) => l.raw_item_id === riceId)!;

    expect(rice.unit_cost).toBeCloseTo(4.5, 6); // (10*3 + 30*5) / 40, NOT (3+5)/2
    expect(rice.line_cost).toBeCloseTo(13.5, 6); // 4.50 x 3
    expect(pilaf.total_cost).toBeCloseTo(13.5, 6);
    expect(pilaf.uncosted_line_count).toBe(0);
  });

  test('an ingredient that was never stocked has no cost basis — null, not zero', async () => {
    const stew = (await fetchDishes()).find((d) => d.id === stewId)!;
    const herb = stew.bill_of_materials.find((l) => l.raw_item_id === herbId)!;

    expect(herb.unit_cost).toBeNull();
    expect(herb.line_cost).toBeNull();
  });

  test('an ingredient whose lots are all consumed is uncosted, not free and not a divide-by-zero', async () => {
    const stew = (await fetchDishes()).find((d) => d.id === stewId)!;
    const spice = stew.bill_of_materials.find((l) => l.raw_item_id === spiceId)!;

    expect(spice.unit_cost).toBeNull();
    expect(spice.line_cost).toBeNull();
  });

  test('a partially costed recipe reports how many lines it could not price', async () => {
    const stew = (await fetchDishes()).find((d) => d.id === stewId)!;

    // Only the rice could be priced: 4.50 x 2.
    expect(stew.total_cost).toBeCloseTo(9, 6);
    // Herb and spice: the total above is a floor, and the caller is told so.
    expect(stew.uncosted_line_count).toBe(2);
  });

  test('consuming stock moves the weighted average, and emptying it removes the basis', async () => {
    // Drain the cheap lot: only 30 @ 5.00 remains, so the average becomes 5.00.
    await admin.$executeRaw`UPDATE public.inventory_batches SET quantity_remaining = 0 WHERE raw_item_id = ${riceId}::uuid AND cost_at_purchase = 3.00`;

    let pilaf = (await fetchDishes()).find((d) => d.id === pilafId)!;
    expect(pilaf.bill_of_materials[0].unit_cost).toBeCloseTo(5, 6);
    expect(pilaf.total_cost).toBeCloseTo(15, 6); // 5.00 x 3

    // Drain everything: the dish can no longer be costed at all.
    await admin.$executeRaw`UPDATE public.inventory_batches SET quantity_remaining = 0 WHERE raw_item_id = ${riceId}::uuid`;

    pilaf = (await fetchDishes()).find((d) => d.id === pilafId)!;
    expect(pilaf.bill_of_materials[0].unit_cost).toBeNull();
    expect(pilaf.total_cost).toBe(0);
    expect(pilaf.uncosted_line_count).toBe(1);

    // Restore for any later run against a shared database.
    await admin.$executeRaw`UPDATE public.inventory_batches SET quantity_remaining = quantity_received WHERE raw_item_id = ${riceId}::uuid AND cost_at_purchase <> 99.00`;
  });
});
