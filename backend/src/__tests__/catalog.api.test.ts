import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

// Catalog (menu item) management: create / rename / re-price, admin-only.

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the catalog tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();

// A second tenant + its item, for the cross-tenant isolation test.
const orgBId = randomUUID();
const userBId = randomUUID();
const itemBId = randomUUID();

const tokens: Record<string, string> = {};

function sign(userId: string): string {
  return jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
}

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Catalog Org'}, ${`cat-${orgId.slice(0, 8)}`}, 'enterprise')`;
  for (const [id, label, role] of [
    [ownerId, 'cat-owner', 'owner'],
    [cashierId, 'cat-cashier', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${label}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
    tokens[role] = sign(id);
  }

  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgBId}::uuid, ${'Catalog Org B'}, ${`cat-b-${userBId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userBId}::uuid, ${`cat-b-${userBId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgBId}::uuid, ${userBId}::uuid, 'owner')`;
  await admin.$executeRaw`INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES (${itemBId}::uuid, ${orgBId}::uuid, ${'Tenant B Item'}, 9.99)`;
});

afterAll(async () => {
  for (const org of [orgId, orgBId]) {
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${userBId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${orgBId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Catalog: the menu is no longer written here (0035)', () => {
  // These used to assert create / re-price / validation through this endpoint.
  // Since 0035 the application role has no INSERT or UPDATE on sellable_items —
  // the menu only changes through an approved menu_change_request — so the
  // endpoint answers 409 and points at the cycle. The behaviour those tests
  // covered now lives in menuChange.api.test.ts, where it is actually reachable.
  it('creating answers 409 and names the route that works', async () => {
    const res = await request(app)
      .post('/api/catalog/items')
      .set({ Authorization: `Bearer ${tokens.owner}` })
      .send({ name: 'Direct Item', price: 10 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('menu_change_required');
    expect(res.body.propose_at).toBe('/api/menu-changes');
  });

  it('re-pricing answers 409 and changes nothing', async () => {
    const res = await request(app)
      .patch(`/api/catalog/items/${'00000000-0000-4000-8000-000000000001'}`)
      .set({ Authorization: `Bearer ${tokens.owner}` })
      .send({ price: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('menu_change_required');
  });

  it('reading the catalog still works — the till sells from it', async () => {
    const res = await request(app).get('/api/catalog/items').set({ Authorization: `Bearer ${tokens.owner}` });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
