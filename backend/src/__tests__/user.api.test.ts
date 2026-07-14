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
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the user tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const userId = randomUUID();
const orgId = randomUUID();
let token: string;

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${userId}::uuid, ${`me-${userId}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Me Org'}, ${`me-${userId.slice(0, 8)}`}, 'basic')`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${userId}::uuid, 'owner')`;

  token = jwt.sign(
    { sub: userId, aud: 'authenticated', role: 'authenticated' },
    JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id = ${userId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Session API', () => {
  test('GET /api/me returns 200 with the caller organization_id', async () => {
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(userId);
    expect(res.body.organization_id).toBe(orgId);
  });

  test('unauthenticated request is rejected with 401', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });
});
