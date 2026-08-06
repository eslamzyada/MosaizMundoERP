import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Per-tenant modules over HTTP (0037).
 *
 * The SQL suite proves the policies. What only this can prove is that the API
 * agrees with them — and, more importantly, that it does not become a SECOND
 * opinion. The refusals below all originate in the database; these tests check
 * they arrive as answers a manager can act on rather than as 500s.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const waiterId = randomUUID();

let ownerToken = '';
let managerToken = '';
let waiterToken = '';

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${orgId}::uuid, ${'Module Org'}, ${`mod-${orgId.slice(0, 8)}`}, 'basic')`;

  for (const [id, prefix, role] of [
    [ownerId, 'mod-own', 'owner'],
    [managerId, 'mod-mgr', 'branch_manager'],
    [waiterId, 'mod-wai', 'waiter'],
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
  managerToken = sign(managerId);
  waiterToken = sign(waiterId);
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.organization_modules WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${managerId}::uuid, ${waiterId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

const setModule = (token: string, key: string, enabled: boolean) =>
  request(app).put(`/api/modules/${key}`).set(as(token)).send({ enabled });

describe('a tenant that never chose', () => {
  it('gets each module at its catalogue default, without a row of its own', async () => {
    // This used to assert "everything is on", which was true only because
    // every module in 0037 defaulted on. 0038's labour module ships OFF — it
    // is a new capability rather than one anybody was already using — so the
    // real contract is the one asserted here: the fallback reads the
    // catalogue, per module, and does not assume a direction.
    const rows = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.organization_modules WHERE organization_id = ${orgId}::uuid`;
    expect(Number(rows[0].count)).toBe(0);

    const defaults = await admin.$queryRaw<Array<{ key: string; default_enabled: boolean }>>`
      SELECT key, default_enabled FROM public.modules`;
    const expected = new Map(defaults.map((d) => [d.key, d.default_enabled]));

    const res = await request(app).get('/api/modules').set(as(ownerToken));
    expect(res.status).toBe(200);
    for (const m of res.body as Array<{ key: string; enabled: boolean }>) {
      expect([m.key, m.enabled]).toEqual([m.key, expected.get(m.key)]);
    }

    // ...and the two directions both genuinely occur, or the loop above would
    // pass against a catalogue that had quietly become uniform.
    expect([...expected.values()]).toContain(true);
    expect([...expected.values()]).toContain(false);
  });

  it('reports the same set on /api/me, so the sidebar needs one request', async () => {
    const me = await request(app).get('/api/me').set(as(waiterToken));
    expect(me.status).toBe(200);
    expect(me.body.modules).toEqual(expect.arrayContaining(['purchasing', 'inventory']));
  });
});

describe('who may change it', () => {
  it('a branch manager may not — this is a subscription, not an operation', async () => {
    const res = await setModule(managerToken, 'printers', false);
    expect(res.status).toBe(403);
  });

  it('a waiter may not', async () => {
    expect((await setModule(waiterToken, 'printers', false)).status).toBe(403);
  });

  it('but everybody may READ what their restaurant runs', async () => {
    // A waiter who cannot find الجرد should learn that the restaurant does not
    // do stocktakes, not conclude the app is broken.
    const res = await request(app).get('/api/modules').set(as(waiterToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(5);
  });

  it('the owner may', async () => {
    const res = await setModule(ownerToken, 'printers', false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'printers', enabled: false });
  });
});

describe('a switched-off module', () => {
  it('answers 409 naming the module — not 500, and not silence', async () => {
    const res = await request(app)
      .get('/api/printers')
      .set(as(ownerToken));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('module_disabled');
    expect(res.body.module).toBe('printers');
    // Actionable: where to switch it back on.
    expect(res.body.enable_at).toBe('/settings');
  });

  it('refuses the write in the DATABASE even with the middleware bypassed', async () => {
    // The point of the whole design. /api/modules is not gated by
    // requireModule, so this reaches Postgres with purchasing off and is
    // refused by the policy rather than by any code in this repository.
    await setModule(ownerToken, 'purchasing', false);

    const direct = admin.$executeRaw`
      SELECT set_config('app.current_user_id', ${ownerId}, false)`;
    await direct;

    const appUser = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    await expect(
      appUser.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
        await tx.$executeRaw`
          INSERT INTO public.suppliers (organization_id, name)
          VALUES (${orgId}::uuid, ${'مورّد ممنوع'})`;
      }),
    ).rejects.toThrow();
    await appUser.$disconnect();
  });

  it('leaves what already happened readable', async () => {
    // Seeded as the superuser because the module is off — the assertion is
    // that a READ still returns it, which is the promise that keeps the books
    // honest when somebody cancels a module.
    const supplierId = randomUUID();
    await admin.$executeRaw`
      INSERT INTO public.suppliers (id, organization_id, name)
      VALUES (${supplierId}::uuid, ${orgId}::uuid, ${'مورّد قديم'})`;

    const appUser = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    const seen = await appUser.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      return tx.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM public.suppliers WHERE id = ${supplierId}::uuid`;
    });
    await appUser.$disconnect();

    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('مورّد قديم');
  });
});

describe('dependencies', () => {
  it('refuses to switch off something another module still needs', async () => {
    await setModule(ownerToken, 'purchasing', true);

    const res = await setModule(ownerToken, 'inventory', false);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('module_dependency');
    // Names what is in the way, as data rather than as a sentence to be parsed.
    expect(['purchasing', 'recipes', 'stocktake', 'waste']).toContain(res.body.blocked_by);
  });

  it('refuses to switch on something whose dependency is off', async () => {
    for (const m of ['purchasing', 'recipes', 'stocktake', 'waste']) {
      await setModule(ownerToken, m, false);
    }
    expect((await setModule(ownerToken, 'inventory', false)).status).toBe(200);

    const res = await setModule(ownerToken, 'purchasing', true);
    expect(res.status).toBe(409);

    // Put it back the right way round, and the same call now works.
    expect((await setModule(ownerToken, 'inventory', true)).status).toBe(200);
    expect((await setModule(ownerToken, 'purchasing', true)).status).toBe(200);
  });
});

describe('the edges', () => {
  it('an unknown module is a 404, not a new row', async () => {
    const res = await setModule(ownerToken, 'teleportation', true);
    expect(res.status).toBe(404);
  });

  it('a non-boolean is a 400', async () => {
    const res = await request(app)
      .put('/api/modules/printers')
      .set(as(ownerToken))
      .send({ enabled: 'yes please' });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/modules')).status).toBe(401);
    expect((await request(app).put('/api/modules/printers').send({ enabled: false })).status).toBe(401);
  });
});
