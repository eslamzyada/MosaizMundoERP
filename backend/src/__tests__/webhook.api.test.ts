import 'dotenv/config';
import request from 'supertest';
import { createHmac, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const WEBHOOK_SECRET = process.env.SUPABASE_WEBHOOK_SECRET;

if (!ADMIN_URL || !WEBHOOK_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_WEBHOOK_SECRET must be set to run the webhook tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

function sign(raw: string): string {
  return createHmac('sha256', WEBHOOK_SECRET as string).update(raw).digest('hex');
}

// Users provisioned by successful tests, torn down in afterAll.
const provisioned: string[] = [];

afterAll(async () => {
  for (const uid of provisioned) {
    const orgs = await admin.$queryRaw<Array<{ organization_id: string }>>`
      SELECT organization_id FROM public.organization_memberships WHERE user_id = ${uid}::uuid`;
    await admin.$executeRaw`DELETE FROM public.users WHERE id = ${uid}::uuid`; // cascades memberships
    for (const o of orgs) {
      await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${o.organization_id}::uuid`;
    }
  }
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('Supabase identity webhook', () => {
  test('valid signature -> 200 and provisions user + org + owner membership', async () => {
    const userId = randomUUID();
    const email = `hook-${userId}@dev.local`;
    provisioned.push(userId);

    const raw = JSON.stringify({
      type: 'INSERT',
      table: 'users',
      schema: 'auth',
      record: { id: userId, email },
    });

    const res = await request(app)
      .post('/api/webhooks/supabase')
      .set('Content-Type', 'application/json')
      .set('x-supabase-signature', sign(raw))
      .send(raw);

    expect(res.status).toBe(200);

    const users = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.users WHERE id = ${userId}::uuid`;
    expect(users.length).toBe(1);

    const memberships = await admin.$queryRaw<Array<{ role: string }>>`
      SELECT role FROM public.organization_memberships WHERE user_id = ${userId}::uuid`;
    expect(memberships.length).toBe(1);
    expect(memberships[0].role).toBe('owner');
  });

  test('missing signature -> 401 and provisions nothing', async () => {
    const userId = randomUUID();
    const raw = JSON.stringify({
      type: 'INSERT',
      record: { id: userId, email: `nosig-${userId}@dev.local` },
    });

    const res = await request(app)
      .post('/api/webhooks/supabase')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(401);

    const users = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.users WHERE id = ${userId}::uuid`;
    expect(users.length).toBe(0);
  });

  test('invalid signature -> 401', async () => {
    const userId = randomUUID();
    const raw = JSON.stringify({
      type: 'INSERT',
      record: { id: userId, email: `badsig-${userId}@dev.local` },
    });

    const res = await request(app)
      .post('/api/webhooks/supabase')
      .set('Content-Type', 'application/json')
      .set('x-supabase-signature', 'deadbeefdeadbeef')
      .send(raw);

    expect(res.status).toBe(401);
  });
});
