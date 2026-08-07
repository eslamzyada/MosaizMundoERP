import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Plans over HTTP (0044).
 *
 * The SQL suites prove the ceiling holds. What only this can prove is that it
 * arrives as an answer somebody can act on — and the whole point of this phase
 * is that there are now THREE different reasons a capability is unavailable,
 * which look identical from a sidebar:
 *
 *   402  your plan does not reach it          → costs money to fix
 *   403  you are not senior enough to decide  → costs a conversation
 *   409  something else depends on it         → costs a different click
 *
 * Collapsing any pair sends the reader to the wrong screen. A 403 in place of
 * a 402 sends an owner looking for someone more senior, and there is nobody
 * more senior than the owner.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const basicOrg = randomUUID();
const bigOrg = randomUUID();
const basicOwner = randomUUID();
const basicWaiter = randomUUID();
const bigOwner = randomUUID();

let basicToken = '';
let waiterToken = '';
let bigToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  for (const [id, slug, plan] of [
    [basicOrg, `plan-basic-${basicOrg.slice(0, 8)}`, 'basic'],
    // The control. Every refusal below has to be about the PLAN, and the only
    // way to show that is an otherwise identical tenant that is allowed.
    [bigOrg, `plan-ent-${bigOrg.slice(0, 8)}`, 'enterprise'],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO public.organizations (id, name, slug, plan_tier)
      VALUES (${id}::uuid, ${'Plan Org'}, ${slug}, ${plan})`;
  }

  for (const [id, prefix, role, org] of [
    [basicOwner, 'plan-own', 'owner', basicOrg],
    [basicWaiter, 'plan-wai', 'waiter', basicOrg],
    [bigOwner, 'plan-big', 'owner', bigOrg],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO public.users (id, email)
      VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`
      INSERT INTO public.organization_memberships (organization_id, user_id, role)
      VALUES (${org}::uuid, ${id}::uuid, ${role})`;
  }

  // One kept promise, written the way 0044's backfill writes them. The app
  // role cannot produce this row by any route, which is the point.
  await admin.$executeRaw`
    INSERT INTO public.organization_modules
        (organization_id, module_key, enabled, grandfathered)
    VALUES (${basicOrg}::uuid, 'exports', true, true)`;

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  basicToken = sign(basicOwner);
  waiterToken = sign(basicWaiter);
  bigToken = sign(bigOwner);
});

afterAll(async () => {
  for (const id of [basicOrg, bigOrg]) {
    await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${id}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${id}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${basicOwner}::uuid, ${basicWaiter}::uuid, ${bigOwner}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${basicOrg}::uuid, ${bigOrg}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('what the plan is, and what it reaches', () => {
  it('rides along with the identity, so the sidebar needs one request', async () => {
    const res = await request(app).get('/api/me').set(as(basicToken));

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('basic');
  });

  it('marks each capability as entitled or not, with the plan that would reach it', async () => {
    const res = await request(app).get('/api/modules').set(as(basicToken));
    const by = (k: string) => res.body.find((m: { key: string }) => m.key === k);

    expect(res.status).toBe(200);
    expect(by('inventory')).toMatchObject({ min_plan: 'basic', entitled: true });
    expect(by('insights')).toMatchObject({ min_plan: 'premium', entitled: false });
    expect(by('menu_approval')).toMatchObject({ min_plan: 'enterprise', entitled: false });
  });

  it('reports a capability above the plan as OFF, not merely un-entitled', async () => {
    // insights is default_enabled. Before 0044 an absent row meant "on", and
    // the sidebar would have offered a screen the database then refused.
    const res = await request(app).get('/api/modules').set(as(basicToken));
    const insights = res.body.find((m: { key: string }) => m.key === 'insights');

    expect(insights.enabled).toBe(false);
    expect(res.body.find((m: { key: string }) => m.key === 'inventory').enabled).toBe(true);
  });

  it('the same catalogue on a bigger plan reaches everything', async () => {
    const res = await request(app).get('/api/modules').set(as(bigToken));
    const by = (k: string) => res.body.find((m: { key: string }) => m.key === k);

    expect(by('insights')).toMatchObject({ entitled: true, enabled: true });
    expect(by('menu_approval')).toMatchObject({ entitled: true, enabled: true });
  });
});

describe('the ceiling, and what it says', () => {
  it('refuses with 402 and names the plan that would do it', async () => {
    const res = await request(app)
      .put('/api/modules/insights')
      .set(as(basicToken))
      .send({ enabled: true });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('plan_required');
    expect(res.body.required_plan).toBe('premium');
    expect(res.body.current_plan).toBe('basic');
  });

  it('is NOT a 403 — there is nobody more senior than the owner to ask', async () => {
    const res = await request(app)
      .put('/api/modules/menu_approval')
      .set(as(basicToken))
      .send({ enabled: true });

    expect(res.status).toBe(402);
    expect(res.status).not.toBe(403);
    expect(res.body.required_plan).toBe('enterprise');
  });

  it('and a 403 is still a 403 when the reason really is seniority', async () => {
    // The waiter is refused for a different reason on the SAME request, which
    // is what makes the distinction above a real one rather than a wording
    // choice. Asked for a module basic DOES reach, so the plan cannot be what
    // refuses them.
    const res = await request(app)
      .put('/api/modules/inventory')
      .set(as(waiterToken))
      .send({ enabled: false });

    expect(res.status).toBe(403);
  });

  it('the same request succeeds on a plan that reaches it', async () => {
    // Without this the tests above would pass equally well against an endpoint
    // that refused everybody.
    const res = await request(app)
      .put('/api/modules/insights')
      .set(as(bigToken))
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'insights', enabled: true });
  });
});

describe('a ceiling, not an assignment', () => {
  it('lets any tier switch something OFF', async () => {
    // Somebody who has stopped paying for a capability should still be able to
    // clear it off their screen — and somebody who never wanted الجرد should
    // not be made to look at it.
    const off = await request(app)
      .put('/api/modules/printers')
      .set(as(basicToken))
      .send({ enabled: false });

    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);

    const back = await request(app)
      .put('/api/modules/printers')
      .set(as(basicToken))
      .send({ enabled: true });

    expect(back.status).toBe(200);
    expect(back.body.enabled).toBe(true);
  });

  it('lets a tenant switch OFF something its plan does not even reach', async () => {
    // The case the printers test above cannot reach, because printers is
    // within basic — so a ceiling applied to BOTH directions would still pass
    // it. insights is premium and this tenant is on basic.
    //
    // Being told to upgrade before you are allowed to say "I do not want this"
    // is absurd, and it is what dropping the `enabled &&` guard produces.
    const res = await request(app)
      .put('/api/modules/insights')
      .set(as(basicToken))
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('honours a kept promise through the same gate that refuses everyone else', async () => {
    // `exports` is premium and this tenant is on basic. It goes through only
    // because 0044's backfill wrote it down as grandfathered.
    const listed = await request(app).get('/api/modules').set(as(basicToken));
    const exp = listed.body.find((m: { key: string }) => m.key === 'exports');
    expect(exp).toMatchObject({ entitled: false, grandfathered: true, enabled: true });

    const off = await request(app)
      .put('/api/modules/exports')
      .set(as(basicToken))
      .send({ enabled: false });
    expect(off.status).toBe(200);

    const on = await request(app)
      .put('/api/modules/exports')
      .set(as(basicToken))
      .send({ enabled: true });

    // A tenant WITHOUT the promise gets 402 for exactly this request.
    expect(on.status).toBe(200);
  });
});
