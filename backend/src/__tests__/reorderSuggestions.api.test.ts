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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the reorder tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();

// Ingredients, each exercising one branch of the suggestion logic.
const lowId = randomUUID(); // below threshold, two suppliers with history
const healthyId = randomUUID(); // comfortably above threshold
const noThresholdId = randomUUID(); // threshold 0 — owner asked for no warning
const onOrderId = randomUUID(); // below threshold but already on order
const orphanId = randomUUID(); // below threshold, never bought from anyone

const dearId = randomUUID(); // supplier that charges more
const cheapId = randomUUID(); // supplier that charges less
const retiredId = randomUUID(); // cheapest of all, but deactivated

const orgBId = randomUUID();
const userBId = randomUUID();

const tokens: Record<string, string> = {};

interface Suggestion {
  raw_item_id: string;
  name: string;
  quantity_on_hand: number;
  reorder_threshold: number;
  quantity_on_order: number;
  shortfall: number;
  suggested_supplier_id: string | null;
  suggested_supplier_name: string | null;
  suggested_unit_price: number | null;
}

async function suggestions(who = 'owner'): Promise<Suggestion[]> {
  const res = await request(app)
    .get('/api/purchase-orders/suggestions')
    .set('Authorization', `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body as Suggestion[];
}

/**
 * A lot of `qty` from `supplier` at `cost`, received `hoursAgo` ago.
 *
 * `remaining` defaults to the full quantity; passing 0 models a delivery that
 * has since been consumed — which still counts as price history but adds
 * nothing to stock on hand. (inventory_batches CHECKs quantity_received > 0, so
 * a zero-quantity lot is not a legal way to record a past price.)
 */
async function lot(
  itemId: string,
  supplier: string | null,
  qty: number,
  cost: number,
  hoursAgo = 0,
  remaining = qty,
) {
  await admin.$executeRaw`
    INSERT INTO public.inventory_batches
      (organization_id, raw_item_id, quantity_received, quantity_remaining,
       cost_at_purchase, supplier_id, received_at)
    VALUES (${orgId}::uuid, ${itemId}::uuid, ${qty}, ${remaining}, ${cost},
            ${supplier}::uuid, now() - make_interval(hours => ${hoursAgo}::int))`;
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Reorder Org'}, ${`ro-${orgId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${ownerId}::uuid, ${`ro-owner-${ownerId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${ownerId}::uuid, 'owner')`;
  tokens.owner = jwt.sign(
    { sub: ownerId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );

  for (const [id, name, active] of [
    [dearId, 'Dear Supplier', true],
    [cheapId, 'Cheap Supplier', true],
    [retiredId, 'Retired Supplier', false],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name, is_active) VALUES (${id}::uuid, ${orgId}::uuid, ${name}, ${active})`;
  }

  for (const [id, name, threshold] of [
    [lowId, 'RO Low', 100],
    [healthyId, 'RO Healthy', 50],
    [noThresholdId, 'RO Unwatched', 0],
    [onOrderId, 'RO On Order', 200],
    [orphanId, 'RO Orphan', 80],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure, reorder_threshold) VALUES (${id}::uuid, ${orgId}::uuid, ${name}, ${'grams'}, ${threshold})`;
  }

  // RO Low: 30 on hand against a threshold of 100 -> 70 short.
  // Three priced deliveries; the RETIRED supplier is cheapest of all and must
  // still be ignored, and the dear supplier's latest price is what counts.
  await lot(lowId, dearId, 10, 0.9, 72);
  await lot(lowId, dearId, 10, 0.8, 48); // dear's latest = 0.80
  await lot(lowId, cheapId, 10, 0.6, 24); // cheap's latest = 0.60
  await lot(lowId, retiredId, 5, 0.1, 12, 0); // cheapest, but deactivated (and used up)

  // Comfortably stocked, so never suggested.
  await lot(healthyId, cheapId, 500, 1.0, 24);

  // Threshold 0: the owner asked not to be warned about this one. Its stock is
  // fully consumed, so it would scream for attention if a 0 threshold meant
  // "always warn" rather than "never warn".
  await lot(noThresholdId, cheapId, 5, 1.0, 24, 0);

  // RO Orphan: 10 on hand against 80, but nothing was ever bought from anyone.
  await lot(orphanId, null, 10, 0.5, 24);

  // RO On Order: 20 on hand against a threshold of 200 — but 500 is inbound.
  await lot(onOrderId, cheapId, 20, 2.0, 24);

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Reorder Org B'}, ${`ro-b-${userBId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`ro-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  tokens.ownerB = jwt.sign(
    { sub: userBId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.purchase_order_lines WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.purchase_orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Reorder suggestions', () => {
  test('an ingredient below its threshold is suggested, with the shortfall', async () => {
    const low = (await suggestions()).find((s) => s.raw_item_id === lowId)!;

    expect(low).toBeDefined();
    expect(Number(low.quantity_on_hand)).toBeCloseTo(30, 6); // 10 + 10 + 10
    expect(Number(low.reorder_threshold)).toBeCloseTo(100, 6);
    expect(Number(low.shortfall)).toBeCloseTo(70, 6);
  });

  test('the cheapest ACTIVE supplier is suggested, by their latest price', async () => {
    const low = (await suggestions()).find((s) => s.raw_item_id === lowId)!;

    // Cheap charges 0.60, Dear's most recent is 0.80 — and the retired supplier
    // is cheapest of all at 0.10 but must not be offered, because it cannot be
    // ordered from.
    expect(low.suggested_supplier_name).toBe('Cheap Supplier');
    expect(low.suggested_supplier_id).toBe(cheapId);
    expect(Number(low.suggested_unit_price)).toBeCloseTo(0.6, 6);
  });

  test('a well-stocked ingredient is not suggested', async () => {
    expect((await suggestions()).some((s) => s.raw_item_id === healthyId)).toBe(false);
  });

  test('a zero threshold means the owner asked for no warning', async () => {
    // On hand is 0, which is below nothing — a 0 threshold is opt-out, not
    // "warn me constantly".
    expect((await suggestions()).some((s) => s.raw_item_id === noThresholdId)).toBe(false);
  });

  test('an ingredient with no purchase history is suggested but names no supplier', async () => {
    const orphan = (await suggestions()).find((s) => s.raw_item_id === orphanId)!;

    expect(Number(orphan.shortfall)).toBeCloseTo(70, 6); // 80 - 10
    // Nothing has ever been bought from anyone, so there is no evidence on
    // which to name a supplier — the UI must ask rather than guess.
    expect(orphan.suggested_supplier_id).toBeNull();
    expect(orphan.suggested_unit_price).toBeNull();
  });

  test('stock already on order is netted off, so nothing is double-ordered', async () => {
    // Before any order exists, it needs 180 (200 threshold - 20 on hand).
    const before = (await suggestions()).find((s) => s.raw_item_id === onOrderId)!;
    expect(Number(before.shortfall)).toBeCloseTo(180, 6);
    expect(Number(before.quantity_on_order)).toBeCloseTo(0, 6);

    // Place an order for 500 — far more than the shortfall.
    const created = await request(app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({
        supplier_id: cheapId,
        lines: [{ raw_item_id: onOrderId, quantity_ordered: 500, unit_price: 2 }],
      });
    expect(created.status).toBe(201);
    await request(app)
      .post(`/api/purchase-orders/${created.body.id}/place`)
      .set('Authorization', `Bearer ${tokens.owner}`);

    // The delivery is inbound, so suggesting another order would double it.
    expect((await suggestions()).some((s) => s.raw_item_id === onOrderId)).toBe(false);
  });

  test('a DRAFT order does not count as inbound — it was never sent', async () => {
    const created = await request(app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({
        supplier_id: cheapId,
        lines: [{ raw_item_id: lowId, quantity_ordered: 500, unit_price: 1 }],
      });
    expect(created.status).toBe(201);

    // Left as a draft: no supplier has been told, so nothing is coming.
    const low = (await suggestions()).find((s) => s.raw_item_id === lowId)!;
    expect(low).toBeDefined();
    expect(Number(low.quantity_on_order)).toBeCloseTo(0, 6);

    await request(app)
      .post(`/api/purchase-orders/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${tokens.owner}`);
  });

  test('a partly delivered order only nets off what is still owed', async () => {
    const created = await request(app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({
        supplier_id: cheapId,
        lines: [{ raw_item_id: orphanId, quantity_ordered: 40, unit_price: 1 }],
      });
    await request(app)
      .post(`/api/purchase-orders/${created.body.id}/place`)
      .set('Authorization', `Bearer ${tokens.owner}`);

    const order = await request(app)
      .get(`/api/purchase-orders/${created.body.id}`)
      .set('Authorization', `Bearer ${tokens.owner}`);
    const lineId = (order.body.lines as Array<{ id: string }>)[0].id;

    // 15 of the 40 arrives: it becomes stock, and 25 is still inbound.
    await request(app)
      .post(`/api/purchase-orders/${created.body.id}/receive`)
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ receipts: [{ line_id: lineId, quantity: 15 }] });

    const orphan = (await suggestions()).find((s) => s.raw_item_id === orphanId)!;
    expect(Number(orphan.quantity_on_hand)).toBeCloseTo(25, 6); // 10 + 15 delivered
    expect(Number(orphan.quantity_on_order)).toBeCloseTo(25, 6); // 40 - 15 still owed
    // 80 threshold - 25 on hand - 25 inbound = 30 still to order.
    expect(Number(orphan.shortfall)).toBeCloseTo(30, 6);
  });

  test("another tenant sees none of this org's shortfalls", async () => {
    const rows = await suggestions('ownerB');
    expect(rows.every((s) => s.raw_item_id !== lowId)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  test('unauthenticated request is rejected with 401', async () => {
    expect((await request(app).get('/api/purchase-orders/suggestions')).status).toBe(401);
  });
});
