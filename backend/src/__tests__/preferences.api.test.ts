import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Appearance settings over HTTP (0032).
 *
 * The database suite proves the policies. What only this can prove is that the
 * API never lets a caller NAME whose preferences it is writing: RLS would
 * refuse a forged user_id, but an endpoint that accepts one is an endpoint
 * somebody will eventually try, and a 200 for "I changed my colleague's
 * settings" would be indistinguishable from success.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the preferences tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();
let managerToken = '';
let cashierToken = '';

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asCashier = () => ({ Authorization: `Bearer ${cashierToken}` });

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Prefs Org'}, ${`prefs-${orgId.slice(0, 8)}`}, 'basic')`;

  for (const [id, prefix, role] of [
    [managerId, 'prefs-mgr', 'branch_manager'],
    [cashierId, 'prefs-csh', 'cashier'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  managerToken = sign(managerId);
  cashierToken = sign(cashierId);
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.user_preferences WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_branding WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('my own preferences', () => {
  it('answers with defaults before anything has been chosen', async () => {
    // Not a 404. Returning one would make every client implement the defaults
    // itself, and they would drift apart.
    const res = await request(app).get('/api/preferences').set(asCashier());
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('system');
    expect(res.body.text_scale).toBe(100);
    expect(res.body.is_stored).toBe(false);
  });

  it('saves a choice and reports it as stored', async () => {
    const put = await request(app)
      .put('/api/preferences')
      .set(asCashier())
      .send({ theme: 'dark', text_scale: 130 });
    expect(put.status).toBe(200);

    const get = await request(app).get('/api/preferences').set(asCashier());
    expect(get.body).toMatchObject({ theme: 'dark', text_scale: 130, is_stored: true });
  });

  it('is partial: changing the theme leaves the text size alone', async () => {
    const res = await request(app)
      .put('/api/preferences')
      .set(asCashier())
      .send({ theme: 'light' });
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('light');
    expect(res.body.text_scale).toBe(130);
  });

  it('refuses a theme it could not render and a size it would not honour', async () => {
    for (const bad of [{ theme: 'neon' }, { text_scale: 10 }, { text_scale: 500 }, { text_scale: 1.5 }]) {
      const res = await request(app).put('/api/preferences').set(asCashier()).send(bad);
      expect(res.status).toBe(400);
    }
  });

  it('THE ONE THAT MATTERS: a body cannot name whose preferences these are', async () => {
    // The manager sends the cashier's id. It must be ignored entirely — not
    // honoured, and not answered with an error that implies it was understood.
    const res = await request(app)
      .put('/api/preferences')
      .set(asManager())
      .send({ user_id: cashierId, organization_id: orgId, theme: 'dark' });
    expect(res.status).toBe(200);

    // The cashier's stored choice is untouched.
    const [row] = await admin.$queryRaw<Array<{ theme: string }>>`
      SELECT theme FROM public.user_preferences WHERE user_id = ${cashierId}::uuid`;
    expect(row.theme).toBe('light');

    // And the manager changed their OWN.
    const mine = await request(app).get('/api/preferences').set(asManager());
    expect(mine.body.theme).toBe('dark');
  });

  it('a colleague never appears in my preferences', async () => {
    const res = await request(app).get('/api/preferences').set(asManager());
    expect(res.body.theme).toBe('dark');
    expect(res.body.text_scale).toBe(100); // the manager never set a size
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/preferences')).status).toBe(401);
    expect((await request(app).put('/api/preferences').send({ theme: 'dark' })).status).toBe(401);
  });
});

describe('the restaurant branding', () => {
  it('a manager sets it', async () => {
    const res = await request(app)
      .put('/api/branding')
      .set(asManager())
      .send({ display_name: 'مطعم الاختبار', logo_url: 'https://example.test/logo.png' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('مطعم الاختبار');
  });

  it('a cashier can READ it — a till prints the logo', async () => {
    const res = await request(app).get('/api/branding').set(asCashier());
    expect(res.status).toBe(200);
    expect(res.body.logo_url).toBe('https://example.test/logo.png');
  });

  it('a cashier cannot change it', async () => {
    const res = await request(app)
      .put('/api/branding')
      .set(asCashier())
      .send({ display_name: 'مطعمي أنا' });
    expect(res.status).toBe(403);

    const [row] = await admin.$queryRaw<Array<{ display_name: string }>>`
      SELECT display_name FROM public.organization_branding WHERE organization_id = ${orgId}::uuid`;
    expect(row.display_name).toBe('مطعم الاختبار');
  });

  it('null clears a logo, which is different from omitting it', async () => {
    const res = await request(app)
      .put('/api/branding')
      .set(asManager())
      .send({ logo_url: null });
    expect(res.status).toBe(200);
    expect(res.body.logo_url).toBeNull();
    // The name was not sent, so it survives.
    expect(res.body.display_name).toBe('مطعم الاختبار');
  });

  it('answers with nulls rather than 404 when nothing is configured', async () => {
    // A restaurant that has not set a logo is not an error state.
    await admin.$executeRaw`DELETE FROM public.organization_branding WHERE organization_id = ${orgId}::uuid`;
    const res = await request(app).get('/api/branding').set(asCashier());
    expect(res.status).toBe(200);
    expect(res.body.logo_url).toBeNull();
    expect(res.body.display_name).toBeNull();
  });
});
