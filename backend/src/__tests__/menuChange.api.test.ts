import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The menu approval cycle over HTTP (0035).
 *
 * The database suite proves the policies and the procedure. What only this can
 * prove is that the API tells the truth about them:
 *
 *   - the old write endpoints answer 409 with the route that DOES work, rather
 *     than a 500 from a privilege that was revoked underneath them.
 *   - "you cannot approve your own" comes back as its own sentence, not as the
 *     same generic 403 a cashier gets. They are different problems with
 *     different fixes.
 *   - approving actually changes the menu, in the same request.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const regionalId = randomUUID();
const kitchenId = randomUUID();
const waiterId = randomUUID();
const itemId = randomUUID();

let ownerToken = '';
let regionalToken = '';
let kitchenToken = '';
let waiterToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Menu Org'}, ${`menu-${orgId.slice(0, 8)}`}, 'enterprise')`;

  for (const [id, prefix, role] of [
    [ownerId, 'menu-own', 'owner'],
    [regionalId, 'menu-reg', 'regional_manager'],
    [kitchenId, 'menu-kit', 'kitchen'],
    [waiterId, 'menu-wai', 'waiter'],
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
  regionalToken = sign(regionalId);
  kitchenToken = sign(kitchenId);
  waiterToken = sign(waiterId);

  // Seeded as the superuser: since 0035 nothing else can write the menu.
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES (${itemId}::uuid, ${orgId}::uuid, ${'فتّة لحم'}, 'FATTA-1', 85.00)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.menu_change_requests WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${regionalId}::uuid, ${kitchenId}::uuid, ${waiterId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

const priceOf = async () => {
  const [row] = await admin.$queryRaw<Array<{ price: unknown }>>`
    SELECT price FROM public.sellable_items WHERE id = ${itemId}::uuid`;
  return Number(row.price);
};

describe('the old way is closed, and says where the new one is', () => {
  it('creating directly answers 409 with the route that works', async () => {
    // Not a 500. The privilege was revoked under this endpoint, and "internal
    // server error" would send a manager to look at the wrong thing.
    const res = await request(app)
      .post('/api/catalog/items')
      .set(as(ownerToken))
      .send({ name: 'طبق مباشر', price: 50 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('menu_change_required');
    expect(res.body.propose_at).toBe('/api/menu-changes');
  });

  it('re-pricing directly answers 409, and the price does not move', async () => {
    const before = await priceOf();
    const res = await request(app)
      .patch(`/api/catalog/items/${itemId}`)
      .set(as(ownerToken))
      .send({ price: 1 });

    expect(res.status).toBe(409);
    expect(await priceOf()).toBe(before);
  });
});

describe('proposing', () => {
  it('the kitchen may propose', async () => {
    const res = await request(app)
      .post('/api/menu-changes')
      .set(as(kitchenToken))
      .send({
        kind: 'update',
        sellable_item_id: itemId,
        price: 95,
        reason: 'ارتفع سعر اللحم من المورّد هذا الشهر',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('a waiter may not', async () => {
    const res = await request(app)
      .post('/api/menu-changes')
      .set(as(waiterToken))
      .send({ kind: 'create', name: 'طبق النادل', price: 20, reason: 'اقتراح' });

    expect(res.status).toBe(403);
  });

  it('a waiter may READ the queue — the price they quote is changing', async () => {
    const res = await request(app).get('/api/menu-changes?status=pending').set(as(waiterToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('demands a reason', async () => {
    const res = await request(app)
      .post('/api/menu-changes')
      .set(as(kitchenToken))
      .send({ kind: 'create', name: 'بلا سبب', price: 10, reason: '' });
    expect(res.status).toBe(400);
  });

  it('refuses a negative price at the proposal, not at the decision', async () => {
    // Catching it here means the queue never contains a change that cannot be
    // applied — otherwise it sits there looking valid until somebody approves it.
    const res = await request(app)
      .post('/api/menu-changes')
      .set(as(kitchenToken))
      .send({ kind: 'create', name: 'سعر سالب', price: -5, reason: 'اختبار' });
    expect(res.status).toBe(400);
  });
});

describe('deciding', () => {
  const pendingId = async () => {
    const res = await request(app).get('/api/menu-changes?status=pending').set(as(ownerToken));
    return (res.body as Array<{ id: string; kind: string }>).find((r) => r.kind === 'update')!.id;
  };

  it('THE TWO-PERSON RULE: the proposer cannot decide their own', async () => {
    const proposal = await request(app)
      .post('/api/menu-changes')
      .set(as(regionalToken))
      .send({ kind: 'create', name: 'طبق المدير', price: 30, reason: 'اقتراح من المدير' });

    const res = await request(app)
      .post(`/api/menu-changes/${proposal.body.id}/decide`)
      .set(as(regionalToken))
      .send({ approve: true });

    expect(res.status).toBe(403);
    // Its own sentence: this is a different problem from "your role cannot
    // decide", and it has a different fix — ask somebody else.
    expect(res.body.error).toMatch(/other than the person who proposed/);
  });

  it('a kitchen member cannot decide at all', async () => {
    const res = await request(app)
      .post(`/api/menu-changes/${await pendingId()}/decide`)
      .set(as(kitchenToken))
      .send({ approve: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner or a regional manager/);
  });

  it('the owner approves the kitchen\'s request, and the menu changes', async () => {
    const id = await pendingId();
    const res = await request(app)
      .post(`/api/menu-changes/${id}/decide`)
      .set(as(ownerToken))
      .send({ approve: true, note: 'موافق' });

    expect(res.status).toBe(200);
    // The decision and the change are one transaction.
    expect(await priceOf()).toBe(95);
  });

  it('a settled request cannot be decided twice', async () => {
    const settled = await request(app).get('/api/menu-changes?status=approved').set(as(ownerToken));
    const id = (settled.body as Array<{ id: string }>)[0].id;

    const res = await request(app)
      .post(`/api/menu-changes/${id}/decide`)
      .set(as(ownerToken))
      .send({ approve: false });

    expect(res.status).toBe(409);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/menu-changes')).status).toBe(401);
    expect((await request(app).post('/api/menu-changes').send({})).status).toBe(401);
  });
});

describe('withdrawing', () => {
  it('the proposer takes their own back', async () => {
    const proposal = await request(app)
      .post('/api/menu-changes')
      .set(as(kitchenToken))
      .send({ kind: 'create', name: 'طبق مؤقت', price: 15, reason: 'سأتراجع عنه' });

    const res = await request(app)
      .post(`/api/menu-changes/${proposal.body.id}/withdraw`)
      .set(as(kitchenToken));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('withdrawn');
  });

  it('somebody else cannot', async () => {
    const proposal = await request(app)
      .post('/api/menu-changes')
      .set(as(kitchenToken))
      .send({ kind: 'create', name: 'طبق آخر', price: 15, reason: 'ليس لغيري' });

    const res = await request(app)
      .post(`/api/menu-changes/${proposal.body.id}/withdraw`)
      .set(as(ownerToken));

    // 404, not 403: the policy scopes the update to nothing, and "no pending
    // request of yours with that id" is the honest answer.
    expect(res.status).toBe(404);
  });
});
