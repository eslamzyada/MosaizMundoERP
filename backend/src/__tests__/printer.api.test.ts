import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Printer configuration over HTTP (0031).
 *
 * The database suite proves the constraints. What is proven here is the part
 * only the API can get wrong: that a second active printer for a role comes
 * back as a 409 a manager can act on rather than a 500 saying "duplicate key",
 * that a cashier reading the address is allowed while a cashier changing it is
 * not, and that `role` cannot be edited in place — flipping it would silently
 * redirect every kitchen ticket to the till by the counter.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the printer tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();
let managerToken = '';
let cashierToken = '';
let foreignPrinterId = '';

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asCashier = () => ({ Authorization: `Bearer ${cashierToken}` });

async function createPrinter(body: Record<string, unknown>, headers = asManager()) {
  return request(app).post('/api/printers').set(headers).send(body);
}

beforeAll(async () => {
  for (const [id, label] of [
    [orgId, 'Printer Org'],
    [otherOrgId, 'Other Printer Org'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${label}, ${`prn-${id.slice(0, 8)}`}, 'enterprise')`;
  }

  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${managerId}::uuid, ${`prn-mgr-${managerId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${managerId}::uuid, 'branch_manager')`;
  await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${cashierId}::uuid, ${`prn-csh-${cashierId.slice(0, 8)}@dev.local`})`;
  await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${orgId}::uuid, ${cashierId}::uuid, 'cashier')`;

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  managerToken = sign(managerId);
  cashierToken = sign(cashierId);

  // Another organization's printer. Seeded as the superuser because RLS hides
  // it from both users above — which is the point.
  foreignPrinterId = randomUUID();
  await admin.$executeRaw`INSERT INTO public.printers (id, organization_id, name, role, host) VALUES (${foreignPrinterId}::uuid, ${otherOrgId}::uuid, ${'Foreign Kitchen'}, 'kitchen', ${'10.99.99.99'})`;
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.printers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('configuring a printer', () => {
  it('creates one, defaulting to the raw-printing port', async () => {
    const res = await createPrinter({ name: 'مطبخ', role: 'kitchen', host: '192.168.1.50' });
    expect(res.status).toBe(201);
    // 9100 is what a network thermal printer listens on. Requiring it to be
    // typed in would mean looking it up to configure the ordinary case.
    expect(res.body.port).toBe(9100);
    expect(res.body.is_active).toBe(true);
  });

  it('refuses a second ACTIVE printer for the same role with an actionable 409', async () => {
    const res = await createPrinter({ name: 'مطبخ ٢', role: 'kitchen', host: '192.168.1.52' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_active_role');
    // "duplicate key" would tell a manager nothing about what to do.
    expect(res.body.error).toMatch(/deactivate/i);
  });

  it('allows the swap: deactivate the old, then add the new', async () => {
    const listed = await request(app).get('/api/printers').set(asManager());
    const current = listed.body.find(
      (p: { role: string; is_active: boolean }) => p.role === 'kitchen' && p.is_active,
    );

    const retired = await request(app)
      .patch(`/api/printers/${current.id}`)
      .set(asManager())
      .send({ is_active: false });
    expect(retired.status).toBe(200);
    expect(retired.body.is_active).toBe(false);

    const replacement = await createPrinter({
      name: 'مطبخ جديد',
      role: 'kitchen',
      host: '192.168.1.60',
    });
    expect(replacement.status).toBe(201);

    // The retired row stays, so what was replaced is still visible.
    const after = await request(app).get('/api/printers').set(asManager());
    const kitchens = after.body.filter((p: { role: string }) => p.role === 'kitchen');
    expect(kitchens).toHaveLength(2);
    expect(kitchens.filter((p: { is_active: boolean }) => p.is_active)).toHaveLength(1);
  });

  it('rejects an unknown role, an impossible port and a blank host', async () => {
    expect((await createPrinter({ name: 'x', role: 'label', host: '1.2.3.4' })).status).toBe(400);
    expect(
      (await createPrinter({ name: 'x', role: 'receipt', host: '1.2.3.4', port: 70000 })).status,
    ).toBe(400);
    expect((await createPrinter({ name: 'x', role: 'receipt', host: '   ' })).status).toBe(400);
  });

  it('will not edit role in place', async () => {
    const listed = await request(app).get('/api/printers').set(asManager());
    const kitchen = listed.body.find(
      (p: { role: string; is_active: boolean }) => p.role === 'kitchen' && p.is_active,
    );

    // Sending it is not an error, but it must be ignored — silently flipping a
    // role would redirect every kitchen ticket to the counter.
    const res = await request(app)
      .patch(`/api/printers/${kitchen.id}`)
      .set(asManager())
      .send({ role: 'receipt', name: 'ما زال المطبخ' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('kitchen');
    expect(res.body.name).toBe('ما زال المطبخ');
  });

  it('deletes a mistyped one outright', async () => {
    const created = await createPrinter({
      name: 'خطأ مطبعي',
      role: 'receipt',
      host: '192.168.9.9',
    });
    const res = await request(app)
      .delete(`/api/printers/${created.body.id}`)
      .set(asManager());
    expect(res.status).toBe(204);
  });
});

describe('who may say where tickets print', () => {
  it('lets a cashier READ the address — they cannot print without it', async () => {
    const res = await request(app).get('/api/printers').set(asCashier());
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('refuses a cashier creating, changing or deleting one', async () => {
    const listed = await request(app).get('/api/printers').set(asCashier());
    const target = listed.body[0];

    expect((await createPrinter({ name: 'x', role: 'receipt', host: '1.1.1.1' }, asCashier())).status)
      .toBe(403);
    expect(
      (await request(app).patch(`/api/printers/${target.id}`).set(asCashier()).send({ host: '10.0.0.1' }))
        .status,
    ).toBe(403);
    expect((await request(app).delete(`/api/printers/${target.id}`).set(asCashier())).status)
      .toBe(403);
  });

  it('hides another organization\'s printers, and refuses writes to them', async () => {
    const listed = await request(app).get('/api/printers').set(asManager());
    expect(listed.body.some((p: { id: string }) => p.id === foreignPrinterId)).toBe(false);

    // RLS filters the row, so the update matches nothing and Prisma reports
    // P2025 — indistinguishable from an id that does not exist, on purpose.
    const res = await request(app)
      .patch(`/api/printers/${foreignPrinterId}`)
      .set(asManager())
      .send({ host: '10.0.0.1' });
    expect(res.status).toBe(404);

    // And it really is untouched.
    const [row] = await admin.$queryRaw<Array<{ host: string }>>`
      SELECT host FROM public.printers WHERE id = ${foreignPrinterId}::uuid`;
    expect(row.host).toBe('10.99.99.99');
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/printers')).status).toBe(401);
    expect((await request(app).post('/api/printers').send({})).status).toBe(401);
  });
});
