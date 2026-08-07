import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The shopfront over HTTP (0040).
 *
 * Every other suite in this folder tests what an authenticated user may do.
 * This one tests what an ANONYMOUS one may do, which is almost nothing — and
 * the assertions are written from the point of view of somebody trying it on.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const ownerId = randomUUID();
const waiterId = randomUUID();
const itemId = randomUUID();
const otherItemId = randomUUID();
const slug = `shop-${orgId.slice(0, 8)}`;

let ownerToken = '';
let waiterToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  for (const [id, name] of [
    [orgId, 'Shop Org'],
    [otherOrgId, 'Other Org'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${name}, ${`po-${id.slice(0, 8)}`}, 'enterprise')`;
  }

  for (const [id, prefix, role] of [
    [ownerId, 'po-own', 'owner'],
    [waiterId, 'po-wai', 'waiter'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  ownerToken = sign(ownerId);
  waiterToken = sign(waiterId);

  // Menu items seeded as the superuser: since 0035 nothing else writes a menu.
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${itemId}::uuid, ${orgId}::uuid, ${'كشري'}, 45.00)`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${otherItemId}::uuid, ${otherOrgId}::uuid, ${'طبق الجيران'}, 99.00)`;

  await admin.$executeRaw`
    INSERT INTO public.organization_modules (organization_id, module_key, enabled)
    VALUES (${orgId}::uuid, 'public_ordering', true)`;
  await admin.$executeRaw`
    INSERT INTO public.storefronts (organization_id, slug, display_name, greeting, is_accepting)
    VALUES (${orgId}::uuid, ${slug}, ${'مطعم الاختبار'}, ${'أهلًا'}, true)`;
});

afterAll(async () => {
  for (const id of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.public_order_lines WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.public_orders WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.storefronts WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.order_items WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${id}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${waiterId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('the public menu', () => {
  it('is readable with no token at all', async () => {
    const res = await request(app).get(`/public/${slug}/menu`);
    expect(res.status).toBe(200);
    expect(res.body.restaurant).toBe('مطعم الاختبار');
    expect(res.body.items.map((i: { name: string }) => i.name)).toContain('كشري');
  });

  it('shows only that restaurant, never anybody else', async () => {
    const res = await request(app).get(`/public/${slug}/menu`);
    const names = res.body.items.map((i: { name: string }) => i.name);
    expect(names).not.toContain('طبق الجيران');
  });

  it('an unknown shopfront is a 404 that says nothing else', async () => {
    const res = await request(app).get('/public/no-such-shop-anywhere/menu');
    expect(res.status).toBe(404);
    // No hint about whether it exists, is closed, or never used the feature.
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});

describe('placing an order without an account', () => {
  let token = '';

  it('works, and returns nothing but a tracking token', async () => {
    const res = await request(app)
      .post(`/public/${slug}/orders`)
      .send({ name: 'زبون', phone: '01000000000', items: [{ item_id: itemId, quantity: 2 }] });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['tracking_token']);
    token = res.body.tracking_token;
  });

  it('THE BIG ONE: a price in the body is not read', async () => {
    const res = await request(app)
      .post(`/public/${slug}/orders`)
      .send({
        name: 'محتال',
        phone: '01000000000',
        items: [{ item_id: itemId, quantity: 2, price: 0.01, unit_price: 0.01 }],
      });
    expect(res.status).toBe(201);

    const [row] = await admin.$queryRaw<Array<{ quoted_total: unknown }>>`
      SELECT quoted_total FROM public.public_orders
       WHERE organization_id = ${orgId}::uuid AND customer_name = 'محتال'`;
    // 2 x 45.00, from the menu.
    expect(Number(row.quoted_total)).toBe(90);
  });

  it('cannot order another restaurant\'s dish through this shopfront', async () => {
    const res = await request(app)
      .post(`/public/${slug}/orders`)
      .send({ name: 'زبون', phone: '01000000000', items: [{ item_id: otherItemId, quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_item');
  });

  it('cannot name a tenant — there is no such parameter', async () => {
    // Sent anyway, in every spelling somebody might try.
    const res = await request(app)
      .post(`/public/${slug}/orders`)
      .send({
        name: 'زبون',
        phone: '01000000000',
        organization_id: otherOrgId,
        organizationId: otherOrgId,
        tenant: otherOrgId,
        items: [{ item_id: itemId, quantity: 1 }],
      });
    expect(res.status).toBe(201);

    // It landed in the shopfront's own restaurant, because the slug decided.
    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.public_orders WHERE organization_id = ${otherOrgId}::uuid`;
    expect(Number(row.count)).toBe(0);
  });

  it('demands a name and a phone number', async () => {
    const noName = await request(app)
      .post(`/public/${slug}/orders`)
      .send({ phone: '01000000000', items: [{ item_id: itemId, quantity: 1 }] });
    expect(noName.status).toBe(400);

    const noPhone = await request(app)
      .post(`/public/${slug}/orders`)
      .send({ name: 'زبون', items: [{ item_id: itemId, quantity: 1 }] });
    expect(noPhone.status).toBe(400);
  });

  it('refuses a silly quantity', async () => {
    const res = await request(app)
      .post(`/public/${slug}/orders`)
      .send({ name: 'زبون', phone: '01000000000', items: [{ item_id: itemId, quantity: 5000 }] });
    expect(res.status).toBe(400);
  });

  it('tracking returns a status and a total, and nothing about anybody else', async () => {
    const res = await request(app).get(`/public/track/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(Object.keys(res.body).sort()).toEqual(['placed_at', 'status', 'total']);
  });

  it('an invented token is a 404', async () => {
    const res = await request(app).get(`/public/track/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('what a public order has NOT done', () => {
  it('moved no stock and made no sale', async () => {
    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.orders WHERE organization_id = ${orgId}::uuid`;
    // The requests exist; not one of them is a sale yet.
    expect(Number(row.count)).toBe(0);
  });
});

describe('the staff queue', () => {
  it('a waiter sees the requests', async () => {
    const res = await request(app).get('/api/public-orders').set(as(waiterToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].lines.length).toBeGreaterThan(0);
  });

  it('accepting turns one into a real order, under the accepter\'s identity', async () => {
    const queue = await request(app).get('/api/public-orders').set(as(waiterToken));
    const first = queue.body[0];

    const res = await request(app)
      .post(`/api/public-orders/${first.id}/accept`)
      .set(as(waiterToken));
    expect(res.status).toBe(200);
    expect(res.body.order_id).toBeTruthy();

    const [order] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.orders WHERE id = ${res.body.order_id}::uuid`;
    expect(Number(order.count)).toBe(1);

    const [decided] = await admin.$queryRaw<Array<{ decided_by: string }>>`
      SELECT decided_by FROM public.public_orders WHERE id = ${first.id}::uuid`;
    expect(decided.decided_by).toBe(waiterId);
  });

  it('accepting the same request twice is a 409, not a second sale', async () => {
    const settled = await request(app)
      .get('/api/public-orders?status=accepted')
      .set(as(waiterToken));
    const already = settled.body[0];

    const res = await request(app)
      .post(`/api/public-orders/${already.id}/accept`)
      .set(as(waiterToken));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_decided');
  });

  it('rejecting needs a reason', async () => {
    const queue = await request(app).get('/api/public-orders').set(as(waiterToken));
    const pending = queue.body[0];

    const noReason = await request(app)
      .post(`/api/public-orders/${pending.id}/reject`)
      .set(as(waiterToken))
      .send({ reason: '  ' });
    expect(noReason.status).toBe(400);

    const ok = await request(app)
      .post(`/api/public-orders/${pending.id}/reject`)
      .set(as(waiterToken))
      .send({ reason: 'المطبخ مغلق' });
    expect(ok.status).toBe(200);
  });

  it('requires authentication — the staff side is not public', async () => {
    expect((await request(app).get('/api/public-orders')).status).toBe(401);
    expect((await request(app).post(`/api/public-orders/${randomUUID()}/accept`)).status).toBe(401);
  });
});

describe('the shopfront settings', () => {
  it('only a manager may change the address', async () => {
    const res = await request(app)
      .put('/api/public-orders/storefront')
      .set(as(waiterToken))
      .send({ is_accepting: false });
    expect(res.status).toBe(403);
  });

  it('closing stops new orders and keeps the ones already taken', async () => {
    const before = await request(app).get('/api/public-orders?status=all').set(as(ownerToken));

    await request(app)
      .put('/api/public-orders/storefront')
      .set(as(ownerToken))
      .send({ is_accepting: false });

    const menu = await request(app).get(`/public/${slug}/menu`);
    expect(menu.status).toBe(404);

    const after = await request(app).get('/api/public-orders?status=all').set(as(ownerToken));
    expect(after.body.length).toBe(before.body.length);
  });

  it('a taken web address is a 409 that says so', async () => {
    await request(app)
      .put('/api/public-orders/storefront')
      .set(as(ownerToken))
      .send({ is_accepting: true });

    await admin.$executeRaw`
      INSERT INTO public.organization_modules (organization_id, module_key, enabled)
      VALUES (${otherOrgId}::uuid, 'public_ordering', true)`;
    await admin.$executeRaw`
      INSERT INTO public.storefronts (organization_id, slug, display_name, is_accepting)
      VALUES (${otherOrgId}::uuid, ${`taken-${otherOrgId.slice(0, 8)}`}, ${'الجيران'}, true)`;

    const res = await request(app)
      .put('/api/public-orders/storefront')
      .set(as(ownerToken))
      .send({ slug: `taken-${otherOrgId.slice(0, 8)}` });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slug_taken');
  });
});
