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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the stocktake tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();

const riceId = randomUUID(); // 1000 across two lots
const saltId = randomUUID(); // never stocked
const orgBId = randomUUID();
const userBId = randomUUID();

const tokens: Record<string, string> = {};

interface Item {
  id: string;
  raw_item_id: string;
  name: string;
  unit_of_measure: string;
  expected_quantity: number;
  counted_quantity: number;
  variance: number;
}
interface Stocktake {
  id: string;
  status: string;
  items: Item[];
}

async function startCount(who = 'owner'): Promise<request.Response> {
  return request(app)
    .post('/api/inventory/stocktakes')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send({});
}

async function fetchCount(id: string, who = 'owner'): Promise<Stocktake> {
  const res = await request(app)
    .get(`/api/inventory/stocktakes/${id}`)
    .set('Authorization', `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body as Stocktake;
}

async function onHand(rawItemId: string): Promise<number> {
  const [row] = await admin.$queryRaw<Array<{ q: unknown }>>`
    SELECT COALESCE(sum(quantity_remaining), 0) AS q
    FROM public.inventory_batches WHERE raw_item_id = ${rawItemId}::uuid`;
  return Number(row.q);
}

/** Removes every stocktake so each test starts from a clean slate. */
async function clearStocktakes(): Promise<void> {
  await admin.$executeRaw`DELETE FROM public.stocktake_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.stocktakes WHERE organization_id = ${orgId}::uuid`;
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Stocktake Org'}, ${`st-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'st-owner', 'owner'],
    [cashierId, 'st-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${riceId}::uuid, ${orgId}::uuid, ${'ST Rice'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${saltId}::uuid, ${orgId}::uuid, ${'ST Salt'}, ${'grams'})`;
  // Two lots; the cheaper expires first so FIFO must take from it first.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date) VALUES (${orgId}::uuid, ${riceId}::uuid, 600, 600, 0.40, now() + interval '3 days')`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date) VALUES (${orgId}::uuid, ${riceId}::uuid, 400, 400, 0.90, now() + interval '30 days')`;

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Stocktake Org B'}, ${`st-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`st-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.stocktake_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.stocktakes WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_deficits WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

beforeEach(clearStocktakes);

describe('Stocktake API', () => {
  test('a new count sheet covers every ingredient, pre-filled with the books', async () => {
    const res = await startCount();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');

    const sheet = await fetchCount(res.body.id);
    const rice = sheet.items.find((i) => i.raw_item_id === riceId)!;
    const salt = sheet.items.find((i) => i.raw_item_id === saltId)!;

    expect(rice.expected_quantity).toBeCloseTo(1000, 6); // 600 + 400
    expect(rice.name).toBe('ST Rice');
    expect(rice.unit_of_measure).toBe('grams');

    // An ingredient with no stock still gets a line: "should be empty" is worth
    // confirming, and it's where found stock turns up.
    expect(salt).toBeDefined();
    expect(salt.expected_quantity).toBeCloseTo(0, 6);

    // Lines start matching the books, so an untouched sheet posts as a no-op
    // rather than wiping stock to zero.
    expect(rice.counted_quantity).toBeCloseTo(1000, 6);
    expect(rice.variance).toBeCloseTo(0, 6);
  });

  test('only one count may be open at a time', async () => {
    const first = await startCount();
    expect(first.status).toBe(201);

    const second = await startCount();
    expect(second.status).toBe(409);
    // The response points at the count already in progress.
    expect(second.body.stocktake_id).toBe(first.body.id);
  });

  test('counting short draws the books down to match, FIFO', async () => {
    const { body } = await startCount();
    const patch = await request(app)
      .patch(`/api/inventory/stocktakes/${body.id}/items`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ counts: [{ raw_item_id: riceId, counted_quantity: 800 }] });
    expect(patch.status).toBe(200);
    expect(patch.body.updated).toBe(1);

    const sheet = await fetchCount(body.id);
    expect(sheet.items.find((i) => i.raw_item_id === riceId)!.variance).toBeCloseTo(-200, 6);

    const post = await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/post`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(post.status).toBe(200);

    // The whole point: the system now says what was counted.
    expect(await onHand(riceId)).toBeCloseTo(800, 6);

    // Taken from the lot expiring soonest.
    const [cheap] = await admin.$queryRaw<Array<{ q: unknown }>>`
      SELECT quantity_remaining AS q FROM public.inventory_batches
      WHERE raw_item_id = ${riceId}::uuid AND cost_at_purchase = 0.40`;
    expect(Number(cheap.q)).toBeCloseTo(400, 6);

    // Absorbed entirely by real stock, so nothing is left outstanding.
    const deficits = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.inventory_deficits WHERE raw_item_id = ${riceId}::uuid`;
    expect(deficits.length).toBe(0);

    // Put it back for the tests that follow.
    await admin.$executeRaw`UPDATE public.inventory_batches SET quantity_remaining = quantity_received WHERE raw_item_id = ${riceId}::uuid`;
  });

  test('counting more than the books adds the surplus', async () => {
    const { body } = await startCount();
    await request(app)
      .patch(`/api/inventory/stocktakes/${body.id}/items`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ counts: [{ raw_item_id: saltId, counted_quantity: 250 }] });

    const post = await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/post`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(post.status).toBe(200);

    expect(await onHand(saltId)).toBeCloseTo(250, 6);

    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE raw_item_id = ${saltId}::uuid`;
  });

  test('a posted count can no longer be edited, posted again, or cancelled', async () => {
    const { body } = await startCount();
    await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/post`)
      .set('Authorization', `Bearer ${tokens.owner}`);

    const patch = await request(app)
      .patch(`/api/inventory/stocktakes/${body.id}/items`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ counts: [{ raw_item_id: riceId, counted_quantity: 1 }] });
    expect(patch.status).toBe(409);

    const repost = await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/post`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(repost.status).toBe(400);

    const cancel = await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/cancel`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(cancel.status).toBe(409);

    // The posted count is still intact — a refused edit changed nothing.
    expect(await onHand(riceId)).toBeCloseTo(1000, 6);
  });

  test('cancelling a draft abandons it without touching stock', async () => {
    const { body } = await startCount();
    await request(app)
      .patch(`/api/inventory/stocktakes/${body.id}/items`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ counts: [{ raw_item_id: riceId, counted_quantity: 0 }] });

    const cancel = await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/cancel`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(cancel.status).toBe(200);

    // A count of 0 was recorded, then abandoned — stock must be untouched.
    expect(await onHand(riceId)).toBeCloseTo(1000, 6);
    expect((await fetchCount(body.id)).status).toBe('cancelled');

    // And cancelling frees the slot for a new count.
    expect((await startCount()).status).toBe(201);
  });

  test('a cashier may read a count but not start, edit, post or cancel one', async () => {
    const { body } = await startCount();

    const read = await request(app)
      .get(`/api/inventory/stocktakes/${body.id}`)
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(read.status).toBe(200);

    expect((await startCount('cashier')).status).toBe(403);

    const patch = await request(app)
      .patch(`/api/inventory/stocktakes/${body.id}/items`)
      .set('Authorization', `Bearer ${tokens.cashier}`)
      .send({ counts: [{ raw_item_id: riceId, counted_quantity: 5 }] });
    expect(patch.status).toBe(403);

    const post = await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/post`)
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(post.status).toBe(403);

    const cancel = await request(app)
      .post(`/api/inventory/stocktakes/${body.id}/cancel`)
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(cancel.status).toBe(403);

    // Nothing the cashier attempted took effect.
    const sheet = await fetchCount(body.id);
    expect(sheet.status).toBe('draft');
    expect(sheet.items.find((i) => i.raw_item_id === riceId)!.counted_quantity).toBeCloseTo(
      1000,
      6,
    );
  });

  test('counts are validated: negative, non-numeric, and empty are refused', async () => {
    const { body } = await startCount();

    for (const bad of [{ raw_item_id: riceId, counted_quantity: -5 }, { raw_item_id: riceId, counted_quantity: 'ten' }, { raw_item_id: 'not-a-uuid', counted_quantity: 5 }]) {
      const res = await request(app)
        .patch(`/api/inventory/stocktakes/${body.id}/items`)
        .set('Authorization', `Bearer ${tokens.owner}`)
        .send({ counts: [bad] });
      expect(res.status).toBe(400);
    }

    const empty = await request(app)
      .patch(`/api/inventory/stocktakes/${body.id}/items`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ counts: [] });
    expect(empty.status).toBe(400);

    // None of the refusals altered the sheet.
    const sheet = await fetchCount(body.id);
    expect(sheet.items.find((i) => i.raw_item_id === riceId)!.counted_quantity).toBeCloseTo(
      1000,
      6,
    );
  });

  test("another tenant's stocktake is invisible", async () => {
    const { body } = await startCount();
    const bToken = jwt.sign(
      { sub: userBId, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );

    const res = await request(app)
      .get(`/api/inventory/stocktakes/${body.id}`)
      .set('Authorization', `Bearer ${bToken}`);
    expect(res.status).toBe(404);

    const list = await request(app)
      .get('/api/inventory/stocktakes')
      .set('Authorization', `Bearer ${bToken}`);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).some((s) => s.id === body.id)).toBe(false);
  });

  test('the list summarises each count', async () => {
    const { body } = await startCount();
    await request(app)
      .patch(`/api/inventory/stocktakes/${body.id}/items`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ counts: [{ raw_item_id: riceId, counted_quantity: 900 }] });

    const res = await request(app)
      .get('/api/inventory/stocktakes')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);

    const row = (res.body as Array<{ id: string; item_count: number; variance_count: number }>).find(
      (s) => s.id === body.id,
    )!;
    expect(row.item_count).toBe(2); // rice + salt
    expect(row.variance_count).toBe(1); // only rice disagrees
  });

  test('unauthenticated requests are rejected with 401', async () => {
    expect((await request(app).get('/api/inventory/stocktakes')).status).toBe(401);
    expect((await request(app).post('/api/inventory/stocktakes').send({})).status).toBe(401);
  });
});
