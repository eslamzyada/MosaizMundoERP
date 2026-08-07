import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

// Proves the middleware verifies ES256 (asymmetric) Supabase tokens — the
// signing scheme of modern Supabase projects — alongside the HS256 test path
// the other suites exercise. Uses a locally generated P-256 keypair standing in
// for Supabase's; the middleware only ever sees the public half, exactly as in
// production.

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('ADMIN_DATABASE_URL must be set to run the ES256 auth tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const otherKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const userId = randomUUID();
const orgId = randomUUID();

function signEs256(key: typeof privateKey, subject: string): string {
  return jwt.sign(
    { sub: subject, aud: 'authenticated', role: 'authenticated' },
    key,
    { algorithm: 'ES256', expiresIn: 3600 },
  );
}

beforeAll(async () => {
  // The middleware reads env per request, so overriding here (after dotenv has
  // loaded the real project key) points ES256 verification at OUR test key.
  process.env.SUPABASE_JWT_PUBLIC_KEY = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();

  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`es256-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'ES256 Org'}, ${`es256-${userId.slice(0, 8)}`}, 'enterprise')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${userId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('ES256 (asymmetric) token verification', () => {
  it('accepts a valid ES256 token and resolves the membership', async () => {
    const token = signEs256(privateKey, userId);
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(userId);
    expect(res.body.organization_id).toBe(orgId);
  });

  it('rejects an ES256 token signed by a different key', async () => {
    const forged = signEs256(otherKeys.privateKey, userId);
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('rejects an HS256 token that uses the PUBLIC key as its secret (alg-confusion)', async () => {
    const confused = jwt.sign(
      { sub: userId, aud: 'authenticated', role: 'authenticated' },
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      { algorithm: 'HS256', expiresIn: 3600 },
    );
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${confused}`);

    expect(res.status).toBe(401);
  });
});
