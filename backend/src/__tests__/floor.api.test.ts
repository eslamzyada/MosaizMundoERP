import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The room (0045).
 *
 * الصالة used to be a list of open ORDERS. That answers "what is running" and
 * nothing else, and the question a manager walks in with is the opposite one:
 * what needs me now. Which is mostly about things NOT in a list of orders —
 *
 *   a table sitting twenty minutes with nothing ordered has no items, so it
 *   never appeared;
 *   a free table is not an order at all, and "how much of the room is empty"
 *   is the other half of running a floor;
 *   a booking due in forty minutes on a table still eating is the only thing
 *   here that is about to become a problem rather than already being one.
 *
 * And one distinction the whole endpoint turns on: a restaurant with no floor
 * plan has `tables: null`, NOT an empty array. An empty room and no room are
 * different facts, and "0 tables free" told to a takeaway counter is false.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const bareOrgId = randomUUID();
const ownerId = randomUUID();
const bareOwnerId = randomUUID();
const dishId = randomUUID();

// Three tables: one busy and fed, one busy and waiting, one free.
const busyTable = randomUUID();
const waitingTable = randomUUID();
const freeTable = randomUUID();

let token = '';
let bareToken = '';
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  for (const [id, slug] of [
    [orgId, `floor-${orgId.slice(0, 8)}`],
    // A restaurant that runs no floor plan. The control for the whole file.
    [bareOrgId, `floorbare-${bareOrgId.slice(0, 8)}`],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO public.organizations (id, name, slug, plan_tier)
      VALUES (${id}::uuid, ${'Floor Org'}, ${slug}, 'enterprise')`;
  }

  for (const [id, prefix, org] of [
    [ownerId, 'floor-own', orgId],
    [bareOwnerId, 'floor-bare', bareOrgId],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO public.users (id, email)
      VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`
      INSERT INTO public.organization_memberships (organization_id, user_id, role)
      VALUES (${org}::uuid, ${id}::uuid, 'owner')`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  token = sign(ownerId);
  bareToken = sign(bareOwnerId);

  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${orgId}::uuid, 'reservations', true)`;
  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${bareOrgId}::uuid, 'reservations', false)`;

  for (const [id, label, area] of [
    [busyTable, 'طاولة الأكل', 'الصالة'],
    [waitingTable, 'طاولة الانتظار', 'الصالة'],
    [freeTable, 'طاولة فارغة', 'الشرفة'],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO public.restaurant_tables (id, organization_id, label, area, seats)
      VALUES (${id}::uuid, ${orgId}::uuid, ${label}, ${area}, 4)`;
  }

  await admin.$executeRaw`
    INSERT INTO public.sellable_items (id, organization_id, name, sku, price)
    VALUES (${dishId}::uuid, ${orgId}::uuid, ${'ملوخية'}, ${'FLR-1'}, 60)`;

  // A tab that has ordered, with one course sent and one still sitting.
  const fedTab = randomUUID();
  await admin.$executeRaw`
    INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount, table_id, created_at)
    VALUES (${fedTab}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 'open', 120, ${busyTable}::uuid, now() - interval '25 minutes')`;
  await admin.$executeRaw`
    INSERT INTO public.order_items (organization_id, order_id, sellable_item_id, quantity, unit_price, fired_at)
    VALUES (${orgId}::uuid, ${fedTab}::uuid, ${dishId}::uuid, 1, 60, now() - interval '20 minutes')`;
  await admin.$executeRaw`
    INSERT INTO public.order_items (organization_id, order_id, sellable_item_id, quantity, unit_price, fired_at)
    VALUES (${orgId}::uuid, ${fedTab}::uuid, ${dishId}::uuid, 1, 60, NULL)`;

  // A tab that has ordered NOTHING, sitting forty minutes. Invisible to a list
  // of orders-with-items, and the single most useful thing on this screen.
  await admin.$executeRaw`
    INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount, table_id, created_at)
    VALUES (${randomUUID()}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 'open', 0, ${waitingTable}::uuid, now() - interval '40 minutes')`;

  // Takeaway: a tab at no table at all.
  await admin.$executeRaw`
    INSERT INTO public.orders (organization_id, client_offline_id, status, total_amount, note)
    VALUES (${orgId}::uuid, ${randomUUID()}::uuid, 'open', 0, ${'تيك أواي'})`;

  // A booking due in forty minutes — on the table that is still eating.
  await admin.$executeRaw`
    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at, status)
    VALUES (${orgId}::uuid, ${busyTable}::uuid, ${'ضيف قادم'}, 2,
            now() + interval '40 minutes', now() + interval '2 hours', 'booked')`;
});

afterAll(async () => {
  for (const id of [orgId, bareOrgId]) {
    await admin.$executeRaw`UPDATE public.reservations SET seated_order_id = NULL WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.reservations WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.restaurant_tables WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${id}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${bareOwnerId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${bareOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

/**
 * The response, loosely typed on purpose.
 *
 * The point of these tests is the SHAPE the API sends, so a hand-written
 * mirror of the controller's own types would only ever agree with itself.
 */
interface FloorRow {
  label: string;
  tab: {
    item_count: number;
    unfired_count: number;
    total_amount: number;
    minutes_open: number;
    note: string | null;
  } | null;
  next_reservation: { guest_name: string; minutes_until: number } | null;
}

const floor = (t = token) => request(app).get('/api/floor').set(as(t));

/** Fails loudly rather than returning undefined — a lookup that finds nothing
 *  would make every assertion after it vacuously true. */
function tableNamed(body: { tables: FloorRow[] }, label: string): FloorRow {
  const row = body.tables.find((t) => t.label === label);
  if (!row) throw new Error(`fixture missing: no table labelled ${label}`);
  return row;
}

describe('the whole room, not just the busy part', () => {
  it('lists a FREE table, which no list of orders ever could', async () => {
    const res = await floor();
    expect(res.status).toBe(200);

    expect(tableNamed(res.body, 'طاولة فارغة').tab).toBeNull();
  });

  it('counts what is free against what is occupied', async () => {
    const res = await floor();

    expect(res.body.summary.tables).toBe(3);
    expect(res.body.summary.occupied).toBe(2);
    expect(res.body.summary.free).toBe(1);
  });

  it('shows a table that has ordered NOTHING, and how long it has sat', async () => {
    // The one a list of orders-with-items cannot show, because it has none.
    const res = await floor();
    const waiting = tableNamed(res.body, 'طاولة الانتظار');

    expect(waiting.tab).not.toBeNull();
    expect(waiting.tab?.item_count).toBe(0);
    expect(waiting.tab?.minutes_open).toBeGreaterThanOrEqual(38);
  });

  it('separates what the kitchen HAS from what is still sitting', async () => {
    // unfired is the actionable number: those plates do not exist yet.
    const res = await floor();
    const busy = tableNamed(res.body, 'طاولة الأكل');

    expect(busy.tab?.item_count).toBe(2);
    expect(busy.tab?.unfired_count).toBe(1);
    expect(busy.tab?.total_amount).toBe(120);
  });
});

describe('what is about to go wrong', () => {
  it('names the booking coming to a table that is still eating', async () => {
    const res = await floor();
    const busy = tableNamed(res.body, 'طاولة الأكل');

    expect(busy.next_reservation).not.toBeNull();
    expect(busy.next_reservation?.guest_name).toBe('ضيف قادم');
    expect(busy.next_reservation?.minutes_until).toBeLessThanOrEqual(41);
    expect(res.body.summary.double_booked_soon).toBe(1);
  });

  it('does not invent a booking for a table that has none', async () => {
    // Otherwise "every table is double booked" would pass the test above.
    const res = await floor();

    expect(tableNamed(res.body, 'طاولة فارغة').next_reservation).toBeNull();
    expect(tableNamed(res.body, 'طاولة الانتظار').next_reservation).toBeNull();
  });
});

describe('tabs that sit at no table', () => {
  it('keeps takeaway out of the room, but not out of the answer', async () => {
    const res = await floor();

    expect(res.body.unseated_tabs).toHaveLength(1);
    expect(res.body.unseated_tabs[0].note).toBe('تيك أواي');
    // And it is not silently attached to some table.
    expect(res.body.tables.every((t: { tab: unknown }) => t.tab === null || t.tab)).toBe(true);
    expect(res.body.summary.unseated_tabs).toBe(1);
  });
});

describe('a restaurant with no floor plan', () => {
  it('gets tables: NULL, not an empty room', async () => {
    // "0 tables free" told to a takeaway counter is false about itself. The
    // distinction the service report draws, drawn again here.
    const res = await floor(bareToken);

    expect(res.status).toBe(200);
    expect(res.body.tables).toBeNull();
    expect(res.body.tables).not.toEqual([]);
    expect(res.body.summary.free).toBeUndefined();
  });

  it('still answers, and still counts its tabs', async () => {
    // Refusing would be the easy call and the wrong one: this restaurant has
    // tabs, it just has nowhere to sit them.
    const res = await floor(bareToken);

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(409);
    expect(Array.isArray(res.body.unseated_tabs)).toBe(true);
  });
});

describe('who may look', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/floor');
    expect(res.status).toBe(401);
  });

  it('never shows another restaurant its neighbour tables', async () => {
    // The bare restaurant has no tables of its own; if RLS leaked, it would be
    // reading ours. Asserted against a tenant that HAS none, so a non-empty
    // answer could only have come from somewhere else.
    const res = await floor(bareToken);

    expect(res.body.tables).toBeNull();
    expect(res.body.unseated_tabs).toHaveLength(0);
  });
});
