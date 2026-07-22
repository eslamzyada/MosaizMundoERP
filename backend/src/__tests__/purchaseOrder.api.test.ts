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
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the purchase order tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();
const supplierId = randomUUID();
const riceId = randomUUID();
const oilId = randomUUID();

// A second tenant whose ingredient must be unreachable from this org's orders.
const orgBId = randomUUID();
const userBId = randomUUID();
const rawBId = randomUUID();

const tokens: Record<string, string> = {};

interface Line {
  id: string;
  raw_item_id: string;
  raw_item_name: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_outstanding: number;
  unit_price: number;
}
interface Order {
  id: string;
  status: string;
  lines: Line[];
}

async function createOrder(body: Record<string, unknown>, who = 'owner') {
  return request(app)
    .post('/api/purchase-orders')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send(body);
}

async function getOrder(id: string, who = 'owner'): Promise<Order> {
  const res = await request(app)
    .get(`/api/purchase-orders/${id}`)
    .set('Authorization', `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body as Order;
}

async function act(id: string, action: string, body: object = {}, who = 'owner') {
  return request(app)
    .post(`/api/purchase-orders/${id}/${action}`)
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send(body);
}

/** A placed order for `qty` of rice at `price`, ready to receive against. */
async function placedOrder(qty = 100, price = 0.2): Promise<Order> {
  const created = await createOrder({
    supplier_id: supplierId,
    lines: [{ raw_item_id: riceId, quantity_ordered: qty, unit_price: price }],
  });
  expect(created.status).toBe(201);
  expect((await act(created.body.id, 'place')).status).toBe(200);
  return getOrder(created.body.id);
}

async function onHand(rawItemId: string): Promise<number> {
  const [row] = await admin.$queryRaw<Array<{ q: unknown }>>`
    SELECT COALESCE(sum(quantity_remaining), 0) AS q
    FROM public.inventory_batches WHERE raw_item_id = ${rawItemId}::uuid`;
  return Number(row.q);
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'PO Org'}, ${`po-${orgId.slice(0, 8)}`}, 'basic')`;
  for (const [id, label, role] of [
    [ownerId, 'po-owner', 'owner'],
    [cashierId, 'po-cash', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = jwt.sign(
      { sub: id, aud: 'authenticated', role: 'authenticated' },
      JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: 3600 },
    );
  }
  await admin.$executeRaw`INSERT INTO public.suppliers (id, organization_id, name) VALUES (${supplierId}::uuid, ${orgId}::uuid, ${'PO Supplier'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${riceId}::uuid, ${orgId}::uuid, ${'PO Rice'}, ${'grams'})`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${oilId}::uuid, ${orgId}::uuid, ${'PO Oil'}, ${'ml'})`;

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'PO Org B'}, ${`po-b-${userBId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`po-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure) VALUES (${rawBId}::uuid, ${orgBId}::uuid, ${'B Item'}, ${'grams'})`;
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
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Purchase orders API', () => {
  test('an order is raised as a draft and cannot take delivery yet', async () => {
    const res = await createOrder({
      supplier_id: supplierId,
      expected_at: new Date(Date.now() + 86400000).toISOString(),
      lines: [
        { raw_item_id: riceId, quantity_ordered: 100, unit_price: 0.2 },
        { raw_item_id: oilId, quantity_ordered: 20, unit_price: 3.5 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');

    const order = await getOrder(res.body.id);
    expect(order.lines).toHaveLength(2);
    expect(order.lines.every((l) => l.quantity_received === 0)).toBe(true);

    // A draft is not a commitment: nothing can arrive against it.
    const early = await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 10 }],
    });
    expect(early.status).toBe(409);
  });

  test('a partial delivery creates stock and leaves the order outstanding', async () => {
    const order = await placedOrder(100, 0.2);
    const before = await onHand(riceId);

    const res = await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 60 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.purchase_order.status).toBe('placed');

    expect(await onHand(riceId)).toBeCloseTo(before + 60, 6);

    const after = await getOrder(order.id);
    expect(after.lines[0].quantity_received).toBeCloseTo(60, 6);
    // The gap IS the outstanding position — the thing that did not exist before.
    expect(after.lines[0].quantity_outstanding).toBeCloseTo(40, 6);
  });

  test('completing every line closes the order', async () => {
    const order = await placedOrder(50, 1.0);
    const res = await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 50 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.purchase_order.status).toBe('received');

    // And a closed order will not quietly reopen.
    const again = await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 5 }],
    });
    expect(again.status).toBe(409);
  });

  test('the invoiced price is recorded when it differs from the quote', async () => {
    const order = await placedOrder(10, 2.0);
    await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 10, unit_cost: 2.75 }],
    });

    const [batch] = await admin.$queryRaw<Array<{ cost_at_purchase: unknown; supplier_id: string }>>`
      SELECT cost_at_purchase, supplier_id FROM public.inventory_batches
      WHERE purchase_order_line_id = ${order.lines[0].id}::uuid`;
    // Charged 2.75 against a quoted 2.00 — exactly the movement the supplier
    // price history exists to surface.
    expect(Number(batch.cost_at_purchase)).toBeCloseTo(2.75, 6);
    // And the lot is attributed to the order's supplier without being told.
    expect(batch.supplier_id).toBe(supplierId);
  });

  test('an over-delivery is recorded in full rather than refused', async () => {
    const order = await placedOrder(100, 0.5);
    const before = await onHand(riceId);

    const res = await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 105 }],
    });
    expect(res.status).toBe(200);
    // Refusing would force the user to understate a real delivery.
    expect(await onHand(riceId)).toBeCloseTo(before + 105, 6);
    expect(res.body.purchase_order.status).toBe('received');
  });

  test('a multi-line delivery is all-or-nothing', async () => {
    const created = await createOrder({
      supplier_id: supplierId,
      lines: [
        { raw_item_id: riceId, quantity_ordered: 10, unit_price: 1 },
        { raw_item_id: oilId, quantity_ordered: 10, unit_price: 1 },
      ],
    });
    await act(created.body.id, 'place');
    const order = await getOrder(created.body.id);
    const riceBefore = await onHand(riceId);

    // The second receipt names a line that is not real, so the whole request
    // must roll back — including the first, valid one.
    const res = await act(order.id, 'receive', {
      receipts: [
        { line_id: order.lines.find((l) => l.raw_item_id === riceId)!.id, quantity: 5 },
        { line_id: randomUUID(), quantity: 5 },
      ],
    });
    expect(res.status).toBe(404);
    expect(await onHand(riceId)).toBeCloseTo(riceBefore, 6);

    const after = await getOrder(order.id);
    expect(after.lines.every((l) => l.quantity_received === 0)).toBe(true);
  });

  test('cancelling keeps stock already delivered', async () => {
    const order = await placedOrder(100, 0.3);
    await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 30 }],
    });
    const delivered = await onHand(riceId);

    const res = await act(order.id, 'cancel');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    // The 30 is physically in the building; unwinding it to tidy a status
    // would corrupt inventory.
    expect(await onHand(riceId)).toBeCloseTo(delivered, 6);

    // A cancelled order takes no further delivery.
    const late = await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 10 }],
    });
    expect(late.status).toBe(409);
  });

  test('a cashier may read orders but not raise, place or receive one', async () => {
    const order = await placedOrder(10, 1);

    const read = await request(app)
      .get('/api/purchase-orders')
      .set('Authorization', `Bearer ${tokens.cashier}`);
    expect(read.status).toBe(200);

    expect(
      (await createOrder(
        { supplier_id: supplierId, lines: [{ raw_item_id: riceId, quantity_ordered: 1, unit_price: 1 }] },
        'cashier',
      )).status,
    ).toBe(403);
    expect((await act(order.id, 'cancel', {}, 'cashier')).status).toBe(403);

    const before = await onHand(riceId);
    expect(
      (await act(order.id, 'receive', { receipts: [{ line_id: order.lines[0].id, quantity: 5 }] }, 'cashier'))
        .status,
    ).toBe(403);
    expect(await onHand(riceId)).toBeCloseTo(before, 6);
  });

  test("an order cannot reference another tenant's ingredient or supplier", async () => {
    const foreignItem = await createOrder({
      supplier_id: supplierId,
      lines: [{ raw_item_id: rawBId, quantity_ordered: 5, unit_price: 1 }],
    });
    expect(foreignItem.status).toBe(400);

    const foreignSupplier = await createOrder({
      supplier_id: randomUUID(),
      lines: [{ raw_item_id: riceId, quantity_ordered: 5, unit_price: 1 }],
    });
    expect(foreignSupplier.status).toBe(400);

    // And tenant B cannot see this org's orders at all.
    const list = await request(app)
      .get('/api/purchase-orders')
      .set('Authorization', `Bearer ${tokens.ownerB}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(0);
  });

  test('order payloads are validated', async () => {
    const bad: Array<Record<string, unknown>> = [
      { supplier_id: supplierId, lines: [] },
      { supplier_id: supplierId, lines: [{ raw_item_id: riceId, quantity_ordered: 0, unit_price: 1 }] },
      { supplier_id: supplierId, lines: [{ raw_item_id: riceId, quantity_ordered: 5, unit_price: -1 }] },
      { supplier_id: 'not-a-uuid', lines: [{ raw_item_id: riceId, quantity_ordered: 5, unit_price: 1 }] },
      {
        supplier_id: supplierId,
        // The same ingredient twice would make "how much is outstanding" ambiguous.
        lines: [
          { raw_item_id: riceId, quantity_ordered: 5, unit_price: 1 },
          { raw_item_id: riceId, quantity_ordered: 5, unit_price: 1 },
        ],
      },
    ];
    for (const body of bad) {
      expect((await createOrder(body)).status).toBe(400);
    }
  });

  test('the list reports what is still outstanding', async () => {
    const order = await placedOrder(100, 0.2);
    await act(order.id, 'receive', {
      receipts: [{ line_id: order.lines[0].id, quantity: 25 }],
    });

    const res = await request(app)
      .get('/api/purchase-orders?status=placed')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(res.status).toBe(200);

    const row = (res.body as Array<{ id: string; outstanding_lines: number; supplier_name: string }>)
      .find((o) => o.id === order.id)!;
    expect(row.supplier_name).toBe('PO Supplier');
    expect(row.outstanding_lines).toBe(1);
  });

  test('unauthenticated requests are rejected with 401', async () => {
    expect((await request(app).get('/api/purchase-orders')).status).toBe(401);
    expect((await request(app).post('/api/purchase-orders').send({})).status).toBe(401);
  });
});
