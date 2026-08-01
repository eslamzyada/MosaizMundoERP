import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The review rubric over HTTP (0033).
 *
 * The database suite proves the policies. What only this can prove is the shape
 * of the answers a manager actually gets:
 *
 *   - deleting a criterion somebody has already been scored against comes back
 *     as a 409 that says "retire it instead", not as a foreign key error mapped
 *     to a 500. The rule is right either way; only one of them is usable.
 *   - a duplicate name is a 409, which needs BOTH of Prisma's collision shapes
 *     to be checked — a typed create raises P2002, the database-side index
 *     raises 23505, and testing one leaves the other returning a 500.
 *   - the weighted average is computed by the SERVER. Two clients deriving it
 *     themselves would eventually derive it differently.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the rating criteria tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const managerId = randomUUID();
const cashierId = randomUUID();
const employeeId = randomUUID();
let foreignCriterionId = '';

let managerToken = '';
let cashierToken = '';

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asCashier = () => ({ Authorization: `Bearer ${cashierToken}` });

const monthStart = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

beforeAll(async () => {
  for (const [id, label] of [
    [orgId, 'Criteria Org'],
    [otherOrgId, 'Other Criteria Org'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${label}, ${`crit-${id.slice(0, 8)}`}, 'basic')`;
  }

  for (const [id, prefix, role] of [
    [managerId, 'crit-mgr', 'branch_manager'],
    [cashierId, 'crit-csh', 'cashier'],
    [employeeId, 'crit-emp', 'staff'],
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

  const [foreign] = await admin.$queryRaw<Array<{ id: string }>>`
    SELECT id::text FROM public.rating_criteria
     WHERE organization_id = ${otherOrgId}::uuid ORDER BY sort_order LIMIT 1`;
  foreignCriterionId = foreign.id;
});

afterAll(async () => {
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.employee_criterion_scores WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.employee_ratings WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.rating_criteria WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid, ${employeeId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

interface Criterion {
  id: string;
  name: string;
  weight: number;
  is_active: boolean;
  sort_order: number;
}

async function criteria(headers = asManager()): Promise<Criterion[]> {
  const res = await request(app).get('/api/rating-criteria').set(headers);
  expect(res.status).toBe(200);
  return res.body as Criterion[];
}

describe('the rubric an organization starts with', () => {
  it('is already there, without anybody creating it', async () => {
    // Seeded by the trigger when the organization was inserted. An empty list
    // would mean a manager has to invent five criteria before they can review
    // anyone, which is a feature nobody discovers.
    const list = await criteria();
    expect(list.length).toBe(5);
    expect(list.map((c) => c.name)).toContain('الالتزام بالمواعيد');
  });

  it('is READABLE by a cashier — the standard is not a secret', async () => {
    const list = await criteria(asCashier());
    expect(list.length).toBe(5);
  });

  it('comes back in the order the sheet is laid out in', async () => {
    const list = await criteria();
    expect(list.map((c) => c.sort_order)).toEqual([...list.map((c) => c.sort_order)].sort((a, b) => a - b));
  });
});

describe('adding criteria of your own', () => {
  it('a manager adds one, beside the seeded five', async () => {
    const res = await request(app)
      .post('/api/rating-criteria')
      .set(asManager())
      .send({ name: 'إتقان تحضير المشاوي', description: 'درجة النضج المطلوبة', weight: 2.5 });

    expect(res.status).toBe(201);
    expect(res.body.weight).toBe(2.5);
    expect(await criteria()).toHaveLength(6);
  });

  it('a duplicate name is a 409 that says so, not a 500', async () => {
    // Both of Prisma's collision shapes have to be handled: a typed create
    // raises P2002, the database index raises 23505.
    const res = await request(app)
      .post('/api/rating-criteria')
      .set(asManager())
      .send({ name: '  إتقان تحضير المشاوي  ' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_name');
  });

  it('refuses a weight that would make it count for nothing', async () => {
    for (const weight of [0, -1, 11]) {
      const res = await request(app)
        .post('/api/rating-criteria')
        .set(asManager())
        .send({ name: `وزن ${weight}`, weight });
      expect(res.status).toBe(400);
    }
  });

  it('refuses a blank name', async () => {
    const res = await request(app)
      .post('/api/rating-criteria')
      .set(asManager())
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('a cashier cannot add one', async () => {
    const res = await request(app)
      .post('/api/rating-criteria')
      .set(asCashier())
      .send({ name: 'معيار من الكاشير' });
    expect(res.status).toBe(403);
    expect((await criteria()).map((c) => c.name)).not.toContain('معيار من الكاشير');
  });
});

describe('scoring against the rubric', () => {
  let criterionId = '';

  beforeAll(async () => {
    criterionId = (await criteria())[0].id;
  });

  it('records a score, and the month is the server\'s to choose', async () => {
    const res = await request(app)
      .put('/api/rating-criteria/scores')
      .set(asManager())
      .send({ employee_id: employeeId, criterion_id: criterionId, score: 4, note: 'تحسّن واضح' });

    expect(res.status).toBe(200);
    const now = monthStart();
    expect(res.body.period_month).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    );
  });

  it('sending it again is a revision, not a second opinion', async () => {
    await request(app)
      .put('/api/rating-criteria/scores')
      .set(asManager())
      .send({ employee_id: employeeId, criterion_id: criterionId, score: 2 });

    const res = await request(app).get('/api/rating-criteria/scores').set(asManager());
    const mine = res.body.employees.find((e: { employee_id: string }) => e.employee_id === employeeId);
    const entry = mine.scores.find((s: { criterion_id: string }) => s.criterion_id === criterionId);
    expect(entry.score).toBe(2);
    expect(mine.scores.filter((s: { criterion_id: string }) => s.criterion_id === criterionId)).toHaveLength(1);
  });

  it('THE ONE THAT MATTERS: the weighted average is the server\'s figure', async () => {
    // Two clients computing this themselves would eventually compute it
    // differently, and a review is not a place for two answers.
    const all = await criteria();
    for (const c of all) {
      await request(app)
        .put('/api/rating-criteria/scores')
        .set(asManager())
        .send({ employee_id: employeeId, criterion_id: c.id, score: 5 });
    }

    const res = await request(app).get('/api/rating-criteria/scores').set(asManager());
    const mine = res.body.employees.find((e: { employee_id: string }) => e.employee_id === employeeId);
    expect(mine.weighted_average).toBe(5);
  });

  it('and it does NOT touch the manager\'s overall rating', async () => {
    await request(app)
      .put('/api/ratings')
      .set(asManager())
      .send({
        employee_id: employeeId,
        // The overall rating names its own month; the criterion scores do not,
        // because only the current one is writable there. Different contracts
        // on purpose, and the older one is not changed to match.
        period_month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
        score: 3,
        note: 'كل بند ممتاز، لكن الحضور يحتاج متابعة',
      });

    const res = await request(app).get('/api/ratings').set(asManager());
    // The list endpoint answers an OBJECT with a `ratings` array, not a bare
    // array — it echoes the window it covered so a caller drawing a trend knows
    // how far back the data reaches.
    const rating = (res.body.ratings as Array<{ employee_id: string; score: number }>).find(
      (r) => r.employee_id === employeeId,
    );
    // Five out of five on every criterion, and the manager still says three.
    expect(rating?.score).toBe(3);
  });

  it('refuses a score off the scale', async () => {
    for (const score of [0, 6, 2.5]) {
      const res = await request(app)
        .put('/api/rating-criteria/scores')
        .set(asManager())
        .send({ employee_id: employeeId, criterion_id: criterionId, score });
      expect(res.status).toBe(400);
    }
  });

  it('nobody scores themselves, and the answer is a sentence', async () => {
    // The CHECK constraint refuses this too, so a status-only assertion passes
    // even with the handler's guard removed — and the database's version of the
    // answer is "rejected by the database", which tells a manager nothing.
    const res = await request(app)
      .put('/api/rating-criteria/scores')
      .set(asManager())
      .send({ employee_id: managerId, criterion_id: criterionId, score: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nobody scores themselves');
  });

  it('a cashier cannot score, and cannot READ the scores', async () => {
    const write = await request(app)
      .put('/api/rating-criteria/scores')
      .set(asCashier())
      .send({ employee_id: employeeId, criterion_id: criterionId, score: 5 });
    expect(write.status).toBe(403);

    // The read gate is the unusual one in this schema, and it is deliberate.
    const read = await request(app).get('/api/rating-criteria/scores').set(asCashier());
    expect(read.status).toBe(403);
  });

  it('a criterion from another restaurant is simply not found', async () => {
    // The composite key makes "does not exist" and "is not yours" the same
    // answer, which is the right amount to tell a caller.
    const res = await request(app)
      .put('/api/rating-criteria/scores')
      .set(asManager())
      .send({ employee_id: employeeId, criterion_id: foreignCriterionId, score: 5 });
    expect(res.status).toBe(404);
  });
});

describe('retiring and removing', () => {
  it('a criterion that has been scored CANNOT be deleted, and says why', async () => {
    // The database refuses it either way; what this endpoint adds is an answer
    // a manager can act on instead of an opaque constraint violation.
    const scored = (await criteria())[0];
    const res = await request(app)
      .delete(`/api/rating-criteria/${scored.id}`)
      .set(asManager());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('criterion_in_use');
    expect(res.body.error).toMatch(/[Rr]etire/);
  });

  it('retiring one keeps its history and takes it off the sheet', async () => {
    const scored = (await criteria())[0];
    const res = await request(app)
      .patch(`/api/rating-criteria/${scored.id}`)
      .set(asManager())
      .send({ is_active: false });
    expect(res.status).toBe(200);

    expect((await criteria()).map((c) => c.id)).not.toContain(scored.id);
    // Still listed when asked for, so it can be brought back.
    const withRetired = await request(app)
      .get('/api/rating-criteria?include_retired=true')
      .set(asManager());
    expect((withRetired.body as Criterion[]).map((c) => c.id)).toContain(scored.id);

    // And the score it carries is still there.
    const scores = await request(app).get('/api/rating-criteria/scores').set(asManager());
    const mine = scores.body.employees.find((e: { employee_id: string }) => e.employee_id === employeeId);
    expect(mine.scores.map((s: { criterion_id: string }) => s.criterion_id)).toContain(scored.id);

    await request(app)
      .patch(`/api/rating-criteria/${scored.id}`)
      .set(asManager())
      .send({ is_active: true });
  });

  it('an UNSCORED criterion can be removed — a typo is not history', async () => {
    const created = await request(app)
      .post('/api/rating-criteria')
      .set(asManager())
      .send({ name: 'خطأ مطبعي' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .delete(`/api/rating-criteria/${created.body.id}`)
      .set(asManager());
    expect(res.status).toBe(204);
    expect((await criteria()).map((c) => c.id)).not.toContain(created.body.id);
  });

  it('another restaurant\'s criterion is a 404, not a 403', async () => {
    // A 403 would confirm it exists. RLS scopes the update to nothing, and
    // "not found" is the honest answer.
    const res = await request(app)
      .patch(`/api/rating-criteria/${foreignCriterionId}`)
      .set(asManager())
      .send({ name: 'مسروق' });
    expect(res.status).toBe(404);

    const [row] = await admin.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM public.rating_criteria WHERE id = ${foreignCriterionId}::uuid`;
    expect(row.name).not.toBe('مسروق');
  });

  it('a cashier cannot delete one', async () => {
    const target = (await criteria())[0];
    const res = await request(app).delete(`/api/rating-criteria/${target.id}`).set(asCashier());
    expect(res.status).toBe(403);
    expect((await criteria()).map((c) => c.id)).toContain(target.id);
  });
});

describe('the tenant boundary', () => {
  it('never lists another restaurant\'s criteria', async () => {
    const list = await criteria();
    expect(list.map((c) => c.id)).not.toContain(foreignCriterionId);
  });

  it('the foreign criterion really exists — the fixture is not inert', async () => {
    const [row] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.rating_criteria WHERE organization_id = ${otherOrgId}::uuid`;
    expect(Number(row.count)).toBe(5);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/rating-criteria')).status).toBe(401);
    expect((await request(app).get('/api/rating-criteria/scores')).status).toBe(401);
  });
});
