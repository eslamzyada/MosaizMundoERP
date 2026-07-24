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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the write-off tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const flourId = randomUUID(); // two lots, different costs and expiry dates
const riceId = randomUUID(); // one lot, already expired
const dryId = randomUUID(); // a lot with NO expiry date at all
const herbId = randomUUID(); // 45 days out and never written off, so the
// expiry-window test has something stable to look at

// Another tenant, whose ingredient must be invisible.
const orgBId = randomUUID();
const userBId = randomUUID();
const itemBId = randomUUID();

const tokens: Record<string, string> = {};
let cheapLot: string;
let dearLot: string;
let expiredLot: string;

async function onHand(rawId: string): Promise<number> {
  const [row] = await admin.$queryRaw<Array<{ q: unknown }>>`
    SELECT COALESCE(sum(quantity_remaining), 0) AS q
    FROM public.inventory_batches WHERE raw_item_id = ${rawId}::uuid`;
  return Number(row.q);
}

async function writeOff(who: string, body: Record<string, unknown>) {
  return request(app)
    .post('/api/inventory/write-offs')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send(body);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'WriteOff Org'}, ${`wo-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'wo-owner', 'owner'],
    [cashierId, 'wo-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }

  for (const [id, name] of [
    [flourId, 'WO Flour'],
    [riceId, 'WO Rice'],
    [dryId, 'WO Salt'],
    [herbId, 'WO Herbs'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${id}::uuid, ${orgId}::uuid, ${name}, ${'kg'})`;
  }

  // Flour: 10 @2.00 expiring in 3 days (FIFO first), 10 @5.00 expiring in 30.
  const [cheap] = await admin.$queryRaw<Array<{ id: string }>>`
    INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date)
    VALUES (${orgId}::uuid, ${flourId}::uuid, 10, 10, 2.00, now() + interval '3 days') RETURNING id`;
  cheapLot = cheap.id;
  const [dear] = await admin.$queryRaw<Array<{ id: string }>>`
    INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date)
    VALUES (${orgId}::uuid, ${flourId}::uuid, 10, 10, 5.00, now() + interval '30 days') RETURNING id`;
  dearLot = dear.id;
  // Rice: already two days past its date.
  const [gone] = await admin.$queryRaw<Array<{ id: string }>>`
    INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date)
    VALUES (${orgId}::uuid, ${riceId}::uuid, 4, 4, 3.00, now() - interval '2 days') RETURNING id`;
  expiredLot = gone.id;
  // Salt: dry goods never turn, so no expiry date.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${dryId}::uuid, 50, 50, 1.00)`;
  // Herbs: 45 days out and deliberately never written off, so the window test
  // has a lot whose presence depends only on the date, not on what other tests
  // have drawn down.
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date) VALUES (${orgId}::uuid, ${herbId}::uuid, 5, 5, 4.00, now() + interval '45 days')`;

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'WriteOff Org B'}, ${`wo-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`wo-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${itemBId}::uuid, ${orgBId}::uuid, ${'B Ingredient'}, ${'kg'})`;
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.stock_write_off_lines WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.stock_write_offs WHERE organization_id = ${org}::uuid`;
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

describe('Recording a write-off', () => {
  test('a cashier may not write stock off, and nothing moves', async () => {
    const before = await onHand(flourId);

    const res = await writeOff('cashier', {
      raw_item_id: flourId,
      quantity: 2,
      reason: 'spoiled',
    });
    expect(res.status).toBe(403);
    expect(await onHand(flourId)).toBeCloseTo(before, 6);
  });

  test('without a lot it draws FIFO, and costs each lot separately', async () => {
    // 12kg: 10 from the 2.00 lot (soonest expiry) + 2 from the 5.00 lot.
    const res = await writeOff('owner', {
      raw_item_id: flourId,
      quantity: 12,
      reason: 'prep_error',
      note: 'over-proofed the batch',
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.quantity_written_off)).toBeCloseTo(12, 6);
    expect(Number(res.body.quantity_short)).toBeCloseTo(0, 6);
    // 10x2.00 + 2x5.00 = 30.00. A weighted average would have said 12x3.50 = 42.
    expect(Number(res.body.total_cost)).toBeCloseTo(30, 6);
    expect(res.body.stock_write_off_lines).toHaveLength(2);

    expect(await onHand(flourId)).toBeCloseTo(8, 6);
  });

  test('naming a lot overrides FIFO — the expiry case', async () => {
    // The dear lot is all that is left of the flour, so use rice: its lot is
    // named explicitly even though nothing else competes, and the line must
    // point at exactly that lot.
    const res = await writeOff('owner', {
      raw_item_id: riceId,
      quantity: 4,
      reason: 'expired',
      batch_id: expiredLot,
    });
    expect(res.status).toBe(201);
    expect(res.body.stock_write_off_lines).toHaveLength(1);
    expect(res.body.stock_write_off_lines[0].batch_id).toBe(expiredLot);
    expect(Number(res.body.total_cost)).toBeCloseTo(12, 6); // 4 x 3.00
    expect(await onHand(riceId)).toBeCloseTo(0, 6);
  });

  test('a named lot with nothing left is 409, not a silent zero write-off', async () => {
    const res = await writeOff('owner', {
      raw_item_id: riceId,
      quantity: 1,
      reason: 'expired',
      batch_id: expiredLot,
    });
    expect(res.status).toBe(409);
  });

  test('discarding more than the books hold succeeds and records the shortfall', async () => {
    // 8kg of flour remain; 10 are binned. The books understated by 2.
    const res = await writeOff('owner', {
      raw_item_id: flourId,
      quantity: 10,
      reason: 'spoiled',
      note: 'walk-in failed',
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.quantity_requested)).toBeCloseTo(10, 6);
    expect(Number(res.body.quantity_written_off)).toBeCloseTo(8, 6);
    expect(Number(res.body.quantity_short)).toBeCloseTo(2, 6);
    // Only the 8 that existed are costed — the shortfall never had a lot.
    expect(Number(res.body.total_cost)).toBeCloseTo(40, 6); // 8 x 5.00

    const [deficit] = await admin.$queryRaw<Array<{ q: unknown }>>`
      SELECT missing_quantity AS q FROM public.inventory_deficits
      WHERE raw_item_id = ${flourId}::uuid`;
    expect(Number(deficit.q)).toBeCloseTo(2, 6);
  });

  test('a staff meal is recorded like any other draw', async () => {
    const res = await writeOff('owner', {
      raw_item_id: dryId,
      quantity: 2,
      reason: 'staff_meal',
    });
    expect(res.status).toBe(201);
    expect(await onHand(dryId)).toBeCloseTo(48, 6);
  });

  test("another tenant's ingredient is 404 — its existence is not confirmed", async () => {
    const res = await writeOff('owner', {
      raw_item_id: itemBId,
      quantity: 1,
      reason: 'spoiled',
    });
    expect(res.status).toBe(404);
  });
});

describe('Write-off validation', () => {
  test('the reason is required, closed, and the answer says what is allowed', async () => {
    for (const reason of [undefined, '', 'shrinkage', 'expiry', 42, null]) {
      const res = await writeOff('owner', { raw_item_id: dryId, quantity: 1, reason });
      expect(res.status).toBe(400);
      expect(res.body.allowed).toContain('expired');
    }
  });

  test("'other' must say what, and whitespace is not an explanation", async () => {
    for (const note of [undefined, '', '   ']) {
      const res = await writeOff('owner', {
        raw_item_id: dryId,
        quantity: 1,
        reason: 'other',
        note,
      });
      expect(res.status).toBe(400);
    }
  });

  test('quantity must be a positive number', async () => {
    for (const quantity of [0, -1, 'two', null, undefined]) {
      const res = await writeOff('owner', { raw_item_id: dryId, quantity, reason: 'spoiled' });
      expect(res.status).toBe(400);
    }
  });

  test('a note longer than the limit is refused', async () => {
    const res = await writeOff('owner', {
      raw_item_id: dryId,
      quantity: 1,
      reason: 'spoiled',
      note: 'x'.repeat(501),
    });
    expect(res.status).toBe(400);
  });

  test('rejected requests moved no stock at all', async () => {
    // Every 400 above targeted the salt; only the staff meal should have.
    expect(await onHand(dryId)).toBeCloseTo(48, 6);
  });
});

describe('Expiring stock', () => {
  interface Lot {
    batch_id: string;
    item_name: string;
    already_expired: boolean;
    days_left: number;
    value_at_risk: unknown;
  }

  async function expiring(days: number, who = 'owner') {
    const res = await request(app)
      .get(`/api/inventory/expiring?days=${days}`)
      .set('Authorization', `Bearer ${tokens[who]}`);
    expect(res.status).toBe(200);
    return res.body.lots as Lot[];
  }

  test('a lot with no expiry date never appears — dry goods do not turn', async () => {
    const lots = await expiring(365);
    expect(lots.some((l) => l.item_name === 'WO Salt')).toBe(false);
  });

  test('the window filters by date', async () => {
    // Herbs are 45 days out and untouched by every other test, so their
    // presence turns on the window alone.
    const near = await expiring(7);
    expect(near.some((l) => l.item_name === 'WO Herbs')).toBe(false);

    const far = await expiring(60);
    const herbs = far.find((l) => l.item_name === 'WO Herbs')!;
    expect(herbs).toBeDefined();
    expect(Number(herbs.value_at_risk)).toBeCloseTo(20, 6); // 5 x 4.00
    expect(herbs.already_expired).toBe(false);
    expect(herbs.days_left).toBeGreaterThan(40);
  });

  test('a lot drawn down to nothing drops off the list', async () => {
    // The dear flour lot is 30 days out, so the date alone would include it —
    // but the write-offs emptied it, and stock that is gone is not at risk.
    const lots = await expiring(60);
    expect(lots.some((l) => l.batch_id === dearLot)).toBe(false);
  });

  test('a cashier may read it — knowing what to use first is their job too', async () => {
    const res = await request(app)
      .get('/api/inventory/expiring?days=7')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(res.status).toBe(200);
  });
});

describe('The write-off log', () => {
  test('lists what was discarded, newest first, with the item named', async () => {
    const res = await request(app)
      .get('/api/inventory/write-offs')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      reason: string;
      raw_inventory_items: { name: string };
      users: { email: string } | null;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0].raw_inventory_items.name).toBeTruthy();
    // Who discarded it is part of the record.
    expect(rows.some((r) => r.users !== null)).toBe(true);
  });
});
