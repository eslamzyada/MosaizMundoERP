import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Open tabs over HTTP (0029).
 *
 * The database suite already proves the state machine and the stock arithmetic.
 * What can only be proven here is the layer between: that Express routes
 * '/orders/open' to the open-tab handler rather than to ':id', that each
 * SQLSTATE becomes the right status code, and that the values the till reads
 * back are the post-write ones.
 *
 * That last point is not hypothetical — an end-to-end run caught the add-items
 * handler returning the total from BEFORE its own insert, because a subquery in
 * the same statement sees that statement's snapshot. Nothing in the type system
 * or the SQL suite could have noticed.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the open tab tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const cashierId = randomUUID();
const accountantId = randomUUID();
const dishId = randomUUID();
const tableId = randomUUID();
const otherTableId = randomUUID();
const foreignTableId = randomUUID();
const ingredientId = randomUUID();
let token = '';
let accountantToken = '';
let foreignOrderId = '';

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function openTab(body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/pos/orders/open')
    .set(auth())
    .send({ organization_id: orgId, client_offline_id: randomUUID(), ...body });
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Tab Org'}, ${`tab-${orgId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${otherOrgId}::uuid, ${'Other Tab Org'}, ${`tab-${otherOrgId.slice(0, 8)}`}, 'enterprise')`;

  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${cashierId}::uuid, ${`tab-${cashierId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${cashierId}::uuid, 'cashier')`;

  // A real MEMBER of the same organization, so a refusal below is about role
  // and not about belonging nowhere.
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${accountantId}::uuid, ${`tab-acc-${accountantId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${accountantId}::uuid, 'accountant')`;

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  token = sign(cashierId);
  accountantToken = sign(accountantId);

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${dishId}::uuid, ${orgId}::uuid, ${'كشري'}, ${'TAB-1'}, 25)`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${ingredientId}::uuid, ${orgId}::uuid, ${'أرز'}, ${'جرام'})`;
  await admin.$executeRaw`INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES (${orgId}::uuid, ${dishId}::uuid, ${ingredientId}::uuid, 100)`;
  await admin.$executeRaw`INSERT INTO public.inventory_batches (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase) VALUES (${orgId}::uuid, ${ingredientId}::uuid, 1000, 1000, 0.10)`;

  // A floor plan (0039), and the module that owns it (0045). Two tables of our
  // own plus one belonging to the other restaurant — the cross-tenant attempt
  // has to be made with a REAL id that is simply not ours, or it degenerates
  // into "a table that does not exist", which any check would refuse.
  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${orgId}::uuid, 'reservations', true)`;
  await admin.$executeRaw`
    INSERT INTO public.restaurant_tables (id, organization_id, label, seats)
    VALUES (${tableId}::uuid, ${orgId}::uuid, ${'طاولة ٧'}, 4)`;
  await admin.$executeRaw`
    INSERT INTO public.restaurant_tables (id, organization_id, label, seats)
    VALUES (${otherTableId}::uuid, ${orgId}::uuid, ${'طاولة ٨'}, 2)`;
  await admin.$executeRaw`
    INSERT INTO public.restaurant_tables (id, organization_id, label, seats)
    VALUES (${foreignTableId}::uuid, ${otherOrgId}::uuid, ${'طاولة الجيران'}, 4)`;

  // An order in the OTHER organization. Seeded as the superuser because RLS
  // hides it from the cashier entirely — which is the point of the test.
  foreignOrderId = randomUUID();
  await admin.$executeRaw`INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount) VALUES (${foreignOrderId}::uuid, ${otherOrgId}::uuid, ${randomUUID()}::uuid, 'open', 0)`;
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.inventory_consumption WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.bill_of_materials WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.inventory_batches WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.restaurant_tables WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${cashierId}::uuid, ${accountantId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('POST /api/pos/orders/open', () => {
  it('opens a tab, and the literal path is not swallowed by :id', async () => {
    // If '/orders/:id/...' were declared first, Express would match this as an
    // order whose id is the string "open" and the handler would 400.
    const res = await openTab({
      note: 'طاولة ٣',
      items: [{ sellable_item_id: dishId, quantity: 2, note: 'حار' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.order_id).toEqual(expect.any(String));
  });

  it('opens an empty tab, because a table is seated before it orders', async () => {
    const res = await openTab();
    expect(res.status).toBe(200);
    expect(res.body.order_id).toEqual(expect.any(String));
  });

  it('is idempotent on client_offline_id', async () => {
    const coid = randomUUID();
    const first = await openTab({ client_offline_id: coid });
    const again = await openTab({ client_offline_id: coid });
    expect(again.status).toBe(200);
    expect(again.body.order_id).toBe(first.body.order_id);
  });

  it('refuses an accountant with 403, not 404', async () => {
    // 404 would mean "you are not in this organization", which is false and
    // would send an admin looking in the wrong place.
    const res = await request(app)
      .post('/api/pos/orders/open')
      .set(auth(accountantToken))
      .send({ organization_id: orgId, client_offline_id: randomUUID() });
    expect(res.status).toBe(403);
  });
});

describe('the tab lifecycle', () => {
  it('adds items and reports the total AFTER the insert', async () => {
    const opened = await openTab({ items: [{ sellable_item_id: dishId, quantity: 1 }] });
    const id = opened.body.order_id;

    const added = await request(app)
      .post(`/api/pos/orders/${id}/items`)
      .set(auth())
      .send({ items: [{ sellable_item_id: dishId, quantity: 2 }] });

    expect(added.status).toBe(200);
    expect(added.body.added).toBe(1);
    // 3 x 25.00. Reading this from a subquery in the same statement as the
    // insert returned 25.00 — the pre-insert snapshot.
    expect(Number(added.body.total_amount)).toBe(75);
  });

  it('lists open tabs with fired_at on every line', async () => {
    const res = await request(app).get('/api/pos/orders/open').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const withLines = res.body.find((o: { order_items: unknown[] }) => o.order_items.length > 0);
    expect(withLines.status).toBe('open');
    // Nothing has been fired, and the till needs that distinction to decide
    // whether a line can still be deleted.
    expect(withLines.order_items[0].fired_at).toBeNull();
    expect(withLines.order_items[0].id).toEqual(expect.any(String));
  });

  it('removes an unfired line, refuses a fired one, and settles', async () => {
    const opened = await openTab({ items: [{ sellable_item_id: dishId, quantity: 1 }] });
    const id = opened.body.order_id;

    await request(app)
      .post(`/api/pos/orders/${id}/items`)
      .set(auth())
      .send({ items: [{ sellable_item_id: dishId, quantity: 1, note: 'يُحذف' }] });

    const listed = await request(app).get('/api/pos/orders/open').set(auth());
    const tab = listed.body.find((o: { id: string }) => o.id === id);
    const doomed = tab.order_items.find((l: { note: string | null }) => l.note === 'يُحذف');

    const removed = await request(app)
      .delete(`/api/pos/orders/items/${doomed.id}`)
      .set(auth());
    expect(removed.status).toBe(204);

    // Settling now would charge for food the kitchen was never told to make.
    const early = await request(app).post(`/api/pos/orders/${id}/settle`).set(auth());
    expect(early.status).toBe(409);

    const fired = await request(app).post(`/api/pos/orders/${id}/fire`).set(auth());
    expect(fired.status).toBe(200);
    expect(fired.body.fired).toBe(1);

    // Pressing send twice must say so rather than silently doing nothing.
    const refired = await request(app).post(`/api/pos/orders/${id}/fire`).set(auth());
    expect(refired.status).toBe(409);

    const after = await request(app).get('/api/pos/orders/open').set(auth());
    const firedTab = after.body.find((o: { id: string }) => o.id === id);
    const firedLine = firedTab.order_items[0];
    expect(firedLine.fired_at).not.toBeNull();

    // The food exists now: taking it off the bill is a void, not a delete.
    const late = await request(app)
      .delete(`/api/pos/orders/items/${firedLine.id}`)
      .set(auth());
    expect(late.status).toBe(409);

    const settled = await request(app).post(`/api/pos/orders/${id}/settle`).set(auth());
    expect(settled.status).toBe(200);
    expect(Number(settled.body.total_amount)).toBe(25);

    const finally_ = await request(app).get('/api/pos/orders/open').set(auth());
    expect(finally_.body.some((o: { id: string }) => o.id === id)).toBe(false);
  });
});

describe('the error contract', () => {
  it('answers 404 for another organization AND for nothing at all, identically', async () => {
    // Distinguishing them would let a till probe which order ids are real in
    // other tenants.
    const foreign = await request(app)
      .post(`/api/pos/orders/${foreignOrderId}/fire`)
      .set(auth());
    const nothing = await request(app)
      .post(`/api/pos/orders/${randomUUID()}/fire`)
      .set(auth());

    expect(foreign.status).toBe(404);
    expect(nothing.status).toBe(404);
    expect(foreign.body).toEqual(nothing.body);
  });

  it('answers 400 for a malformed id, without reaching the database', async () => {
    const res = await request(app).post('/api/pos/orders/not-a-uuid/fire').set(auth());
    expect(res.status).toBe(400);
  });

  it('rejects an empty items array', async () => {
    const opened = await openTab();
    const res = await request(app)
      .post(`/api/pos/orders/${opened.body.order_id}/items`)
      .set(auth())
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/pos/orders/open')).status).toBe(401);
    expect((await request(app).post('/api/pos/orders/open').send({})).status).toBe(401);
  });
});


/**
 * The table a tab is running at (0045).
 *
 * 0043 put `table_id` on orders with a composite FK and a one-tab-per-table
 * index; until now the only thing that ever set it was the admin seating a
 * booking. A waiter opening a tab wrote the table into `note`, as free text —
 * so "طاولة ٥" and "T5" were two tables to the database and one to the
 * restaurant, and nothing stopped two tabs on one table.
 */
describe('opening a tab AT a table', () => {
  it('links the tab to the table', async () => {
    const res = await openTab({ table_id: tableId });
    expect(res.status).toBe(200);

    const row = await admin.$queryRaw<Array<{ table_id: string | null }>>`
      SELECT table_id FROM public.orders WHERE id = ${res.body.order_id}::uuid`;
    expect(row[0].table_id).toBe(tableId);
  });

  it('carries the table LABEL on the tab list, not just its id', async () => {
    // A till showing a uuid is a till nobody can use.
    const list = await request(app).get('/api/pos/orders/open').set(auth());
    const tab = list.body.find(
      (o: { restaurant_tables?: { id: string } }) => o.restaurant_tables?.id === tableId,
    );

    expect(tab).toBeDefined();
    expect(tab.restaurant_tables.label).toBe('طاولة ٧');
  });

  it('refuses a SECOND tab on the same table, and says which table', async () => {
    const res = await openTab({ table_id: tableId });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('طاولة ٧');
  });

  it('is still idempotent — a retry gets its own tab back, not a busy table', async () => {
    // The one that breaks exactly when the wifi is bad, which is when it
    // matters. Same client_offline_id, twice.
    const coid = randomUUID();
    const first = await request(app)
      .post('/api/pos/orders/open')
      .set(auth())
      .send({ organization_id: orgId, client_offline_id: coid, table_id: otherTableId });
    const again = await request(app)
      .post('/api/pos/orders/open')
      .set(auth())
      .send({ organization_id: orgId, client_offline_id: coid, table_id: otherTableId });

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.order_id).toBe(first.body.order_id);
  });

  it('refuses a table belonging to another restaurant, as a bad request', async () => {
    // 404 would send the till looking for an order it never mentioned.
    const res = await openTab({ table_id: foreignTableId });

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(404);
  });

  it('still opens a tab with NO table — takeaway exists', async () => {
    const res = await openTab({ note: 'تيك أواي' });

    expect(res.status).toBe(200);
    const row = await admin.$queryRaw<Array<{ table_id: string | null }>>`
      SELECT table_id FROM public.orders WHERE id = ${res.body.order_id}::uuid`;
    expect(row[0].table_id).toBeNull();
  });
});
