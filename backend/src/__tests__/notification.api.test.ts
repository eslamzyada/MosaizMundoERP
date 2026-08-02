import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Inboxes over HTTP (0036).
 *
 * The database suite proves the policies. What only this can prove is that the
 * API never grew a way to SEND one — there is no endpoint, and the two events
 * that exist arrive as a side effect of the menu cycle rather than from any
 * request a client can make.
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
let kitchenToken = '';
let waiterToken = '';
let regionalToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Notify Org'}, ${`ntf-${orgId.slice(0, 8)}`}, 'basic')`;

  for (const [id, prefix, role] of [
    [ownerId, 'ntf-own', 'owner'],
    [regionalId, 'ntf-reg', 'regional_manager'],
    [kitchenId, 'ntf-kit', 'kitchen'],
    [waiterId, 'ntf-wai', 'waiter'],
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

  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${itemId}::uuid, ${orgId}::uuid, ${'فتّة'}, 80.00)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.notifications WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.menu_change_requests WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${regionalId}::uuid, ${kitchenId}::uuid, ${waiterId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

const inbox = async (token: string) => {
  const res = await request(app).get('/api/notifications').set(as(token));
  expect(res.status).toBe(200);
  return res.body as {
    unread: number;
    notifications: Array<{ id: string; kind: string; subject: string; link: string | null; read_at: string | null }>;
  };
};

describe('a proposal reaches the people who can decide it', () => {
  it('tells the owner and the regional manager, not the proposer', async () => {
    await request(app)
      .post('/api/menu-changes')
      .set(as(kitchenToken))
      .send({
        kind: 'update',
        sellable_item_id: itemId,
        price: 90,
        reason: 'ارتفعت تكلفة المكوّنات',
      });

    const owner = await inbox(ownerToken);
    expect(owner.unread).toBe(1);
    expect(owner.notifications[0].kind).toBe('menu_change_proposed');
    // It points somewhere. A notification you cannot act on is an interruption.
    expect(owner.notifications[0].link).toBe('/menu');

    expect((await inbox(regionalToken)).unread).toBe(1);
    // The person who proposed it already knows.
    expect((await inbox(kitchenToken)).unread).toBe(0);
  });

  it('does NOT tell a waiter, who cannot decide anything', async () => {
    // Containment: recipients are chosen by role at the moment of the event.
    expect((await inbox(waiterToken)).unread).toBe(0);
  });
});

describe('a decision reaches whoever asked', () => {
  it('tells the proposer what happened', async () => {
    const pending = await request(app)
      .get('/api/menu-changes?status=pending')
      .set(as(ownerToken));
    const id = (pending.body as Array<{ id: string }>)[0].id;

    await request(app)
      .post(`/api/menu-changes/${id}/decide`)
      .set(as(ownerToken))
      .send({ approve: true, note: 'موافق' });

    const kitchen = await inbox(kitchenToken);
    expect(kitchen.unread).toBe(1);
    expect(kitchen.notifications[0].kind).toBe('menu_change_decided');
    expect(kitchen.notifications[0].subject).toMatch(/اعتماد/);
  });

  it('does not tell the decider about their own decision', async () => {
    const owner = await inbox(ownerToken);
    expect(owner.notifications.filter((n) => n.kind === 'menu_change_decided')).toHaveLength(0);
  });
});

describe('an inbox is private', () => {
  it('nobody sees anybody else\'s', async () => {
    const owner = await inbox(ownerToken);
    const kitchen = await inbox(kitchenToken);

    const overlap = owner.notifications
      .map((n) => n.id)
      .filter((id) => kitchen.notifications.some((k) => k.id === id));
    expect(overlap).toEqual([]);
  });

  it('marking somebody else\'s read is a 404, not a 403', async () => {
    // A 403 would confirm the row exists. The policy scopes the update to
    // nothing and "no unread notification of yours" is the honest answer.
    const owner = await inbox(ownerToken);
    const target = owner.notifications.find((n) => n.read_at === null)!;

    const res = await request(app)
      .post(`/api/notifications/${target.id}/read`)
      .set(as(waiterToken));
    expect(res.status).toBe(404);

    // And it really is still unread for the person it belongs to.
    expect((await inbox(ownerToken)).unread).toBeGreaterThan(0);
  });
});

describe('reading', () => {
  it('marks one, and the count drops', async () => {
    const before = await inbox(ownerToken);
    const target = before.notifications.find((n) => n.read_at === null)!;

    const res = await request(app)
      .post(`/api/notifications/${target.id}/read`)
      .set(as(ownerToken));
    expect(res.status).toBe(200);

    expect((await inbox(ownerToken)).unread).toBe(before.unread - 1);
  });

  it('marking the same one twice is a 404, not a second success', async () => {
    const owner = await inbox(ownerToken);
    const alreadyRead = owner.notifications.find((n) => n.read_at !== null)!;

    const res = await request(app)
      .post(`/api/notifications/${alreadyRead.id}/read`)
      .set(as(ownerToken));
    expect(res.status).toBe(404);
  });

  it('read-all clears the badge', async () => {
    await request(app).post('/api/notifications/read-all').set(as(regionalToken));
    expect((await inbox(regionalToken)).unread).toBe(0);
  });

  it('an id that is not a uuid is a 400, not a 500', async () => {
    // Without the guard this reaches Prisma as a malformed uuid and comes back
    // as an internal error — which sends somebody to read server logs over a
    // typo in a URL.
    const res = await request(app).post('/api/notifications/read-all/read').set(as(ownerToken));
    expect(res.status).toBe(400);
  });
});

describe('there is no way to send one', () => {
  it('the API exposes no create endpoint at all', async () => {
    const res = await request(app)
      .post('/api/notifications')
      .set(as(ownerToken))
      .send({ recipient_id: waiterId, kind: 'phish', subject: 'أدخل كلمة المرور' });

    // 404 from Express: the route does not exist. Not a 403 from a guard that
    // somebody could later relax.
    expect(res.status).toBe(404);
    expect((await inbox(waiterToken)).notifications.some((n) => n.kind === 'phish')).toBe(false);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/notifications')).status).toBe(401);
    expect((await request(app).post('/api/notifications/read-all')).status).toBe(401);
  });
});
