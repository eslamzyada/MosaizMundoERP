import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * Cash-ups, and the pattern in them (0047).
 *
 * The single-night alert already exists. What this adds is the question no
 * sequence of alerts ever answers: is it the same person, and how often?
 *
 * Which makes this the most consequential thing in the system to get wrong,
 * because it puts names next to missing money. Most of the assertions below
 * are about NOT overstating:
 *
 *   - net and short_nights are reported together, because ten over on Monday
 *     and ten short on Tuesday nets to zero and is two mistakes, not none;
 *   - every count carries its denominator, because whoever closes the most
 *     drawers tops any absolute count — which would point a manager at their
 *     most reliable person;
 *   - nothing is ranked by variance, scored, or flagged.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error('ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run these tests');
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const ownerId = randomUUID();
const cashierId = randomUUID();   // closes many, short often
const reliableId = randomUUID();  // closes many, never short
const rareId = randomUUID();      // closes once, short once

let ownerToken = '';
let cashierToken = '';
const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const window = `from=${new Date(Date.now() - 7 * 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`;

/** A closed drawer, written directly: the procedures are proven elsewhere. */
async function closedSession(closedBy: string, variance: number, agoHours: number) {
  const expected = 500;
  await admin.$executeRaw`
    INSERT INTO public.till_sessions
        (organization_id, opened_at, opened_by, opening_float,
         closed_at, closed_by, counted_cash, expected_cash, variance)
    VALUES (${orgId}::uuid,
            now() - (${agoHours + 8} || ' hours')::interval, ${closedBy}::uuid, 100,
            now() - (${agoHours} || ' hours')::interval, ${closedBy}::uuid,
            ${expected + variance}, ${expected}, ${variance})`;
}

beforeAll(async () => {
  await admin.$executeRaw`
    INSERT INTO public.organizations (id, name, slug, plan_tier)
    VALUES (${orgId}::uuid, ${'Till History Org'}, ${`th-${orgId.slice(0, 8)}`}, 'enterprise')`;

  for (const [id, prefix, role] of [
    [ownerId, 'th-own', 'owner'],
    [cashierId, 'th-cash', 'cashier'],
    [reliableId, 'th-rel', 'cashier'],
    [rareId, 'th-rare', 'cashier'],
  ] as const) {
    await admin.$executeRaw`
      INSERT INTO public.users (id, email)
      VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`
      INSERT INTO public.organization_memberships (organization_id, user_id, role)
      VALUES (${orgId}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  ownerToken = sign(ownerId);
  cashierToken = sign(cashierId);

  // Four drawers, three of them short. Net -30.
  await closedSession(cashierId, -10, 10);
  await closedSession(cashierId, -20, 34);
  await closedSession(cashierId, 20, 58);   // over once: net hides two of these
  await closedSession(cashierId, -20, 82);

  // Four drawers, every one exact. The control: without somebody who is never
  // short, "short_rate" could be reported as a constant and nothing would fail.
  for (const h of [11, 35, 59, 83]) await closedSession(reliableId, 0, h);

  // One drawer, short. Same short_nights as nothing, a very different rate.
  await closedSession(rareId, -20, 12);

  // And one drawer still OPEN. It has no variance yet, and a blank in a
  // column of variances gets read as a zero — so it must not appear at all.
  await admin.$executeRaw`
    INSERT INTO public.till_sessions
        (organization_id, opened_at, opened_by, opening_float)
    VALUES (${orgId}::uuid, now() - interval '1 hour', ${cashierId}::uuid, 100)`;
});

afterAll(async () => {
  await admin.$executeRaw`DELETE FROM public.till_sessions WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${orgId}::uuid`;
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${ownerId}::uuid, ${cashierId}::uuid, ${reliableId}::uuid, ${rareId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id = ${orgId}::uuid`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

interface Person {
  closed_by: string | null;
  sessions: number;
  net: number;
  short_nights: number;
  over_nights: number;
  short_rate: number | null;
  worst_short: number;
}
const history = () => request(app).get(`/api/till/sessions?${window}`).set(as(ownerToken));
const person = (body: { people: Person[] }, id: string) => {
  const p = body.people.find((x) => x.closed_by === id);
  if (!p) throw new Error(`no person row for ${id}`);
  return p;
};

describe('the nights themselves', () => {
  it('lists closed drawers, newest first', async () => {
    const res = await history();

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(9);
    const times = res.body.sessions.map((s: { closed_at: string }) => s.closed_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('counts what balanced against what did not', async () => {
    const res = await history();

    expect(res.body.summary.closed).toBe(9);
    expect(res.body.summary.balanced).toBe(4);
    expect(res.body.summary.out).toBe(5);
  });

  it('leaves the OPEN drawer out entirely', async () => {
    // It has no variance yet. Listing it would put a blank in a column of
    // numbers, and a blank among variances reads as "balanced".
    const res = await history();

    expect(res.body.sessions.every((s: { closed_at: string | null }) => s.closed_at !== null)).toBe(true);
    expect(res.body.summary.closed).toBe(9);
    // And it must not have inflated anybody's denominator either.
    expect(person(res.body, cashierId).sessions).toBe(4);
  });

  it('reports the gross short beside the net, not instead of it', async () => {
    // Net across everybody is -50; the money that actually went missing is
    // -70, because a +20 night masks one of the shortfalls. A report showing
    // only net says the month was better than it was.
    const res = await history();

    expect(res.body.summary.net).toBe(-50);
    expect(res.body.summary.total_short).toBe(-70);
  });
});

describe('the pattern, without the accusation', () => {
  it('gives each person their counts AND their denominator', async () => {
    const res = await history();
    const p = person(res.body, cashierId);

    expect(p.sessions).toBe(4);
    expect(p.short_nights).toBe(3);
    expect(p.over_nights).toBe(1);
    expect(p.short_rate).toBeCloseTo(75, 1);
  });

  it('does not let a net of zero hide two mistakes', async () => {
    // The whole reason short_nights exists next to net.
    const res = await history();
    const p = person(res.body, cashierId);

    expect(p.net).toBe(-30);
    expect(p.short_nights).toBeGreaterThan(0);
    expect(p.over_nights).toBeGreaterThan(0);
  });

  it('separates somebody short once from somebody short often', async () => {
    // Both are "short" in an absolute count. One closed four drawers, the
    // other one — and the rate is the only thing that tells them apart.
    const res = await history();
    const often = person(res.body, cashierId);
    const once = person(res.body, rareId);

    expect(once.short_nights).toBeLessThan(often.short_nights);
    // ...and yet the rare one is short EVERY time they close.
    expect(once.short_rate).toBe(100);
    expect(often.short_rate).toBeCloseTo(75, 1);
  });

  it('shows the reliable person as reliable, rather than omitting them', async () => {
    // Without a never-short person in the response, a short_rate hardcoded to
    // 100 would pass every test above.
    const res = await history();
    const p = person(res.body, reliableId);

    expect(p.sessions).toBe(4);
    expect(p.short_nights).toBe(0);
    expect(p.short_rate).toBe(0);
    expect(p.net).toBe(0);
  });

  it('is NOT ordered by who looks worst', async () => {
    // A response sorted by variance is a ranking of suspicion, and it gets
    // read as evidence. Ordered by how many drawers each closed.
    const res = await history();
    const counts = res.body.people.map((p: Person) => p.sessions);

    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    // And the worst net is not first, which is what a suspicion sort would do.
    expect(res.body.people[0].closed_by).not.toBe(rareId);
  });
});

describe('who may read it', () => {
  it('a cashier may not — it names people beside missing money', async () => {
    // They may WORK the till; reading back everybody's shortfalls is a
    // different act. The three till endpoints stay open; this one does not.
    const res = await request(app).get(`/api/till/sessions?${window}`).set(as(cashierToken));

    expect(res.status).toBe(403);
  });

  it('but the cashier can still open and close a drawer', async () => {
    // Proves the gate above is on THIS endpoint and not on the till itself.
    const res = await request(app).get('/api/till').set(as(cashierToken));

    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/till/sessions')).status).toBe(401);
  });

  it('refuses a window that runs backwards', async () => {
    const res = await request(app)
      .get(`/api/till/sessions?from=${new Date().toISOString()}&to=${new Date(Date.now() - 86400_000).toISOString()}`)
      .set(as(ownerToken));

    expect(res.status).toBe(400);
  });
});
