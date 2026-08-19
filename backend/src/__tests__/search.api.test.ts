import 'dotenv/config';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { app } from '../app';
import { prisma } from '../prisma';

/**
 * The search box, over HTTP.
 *
 * Three things here can go wrong quietly, and all three look like success from
 * the outside:
 *
 *   1. LIKE syntax leaking through. "%" typed into a search box either matches
 *      everything (which reads as a generous search) or, worse, matches across
 *      a name it should not. Only a pair of assertions can tell those apart —
 *      one that the literal IS found, one that the wildcard is NOT honoured.
 *   2. A single noisy kind filling the answer. Forty matching ingredients and
 *      one matching supplier is a correct-looking response that has hidden the
 *      result somebody was looking for.
 *   3. A tenant boundary that is never actually tested, because the foreign row
 *      has a different name and would not have matched anyway. Every
 *      cross-tenant row below is seeded with the SAME name as ours.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!ADMIN_URL || !JWT_SECRET) {
  throw new Error(
    'ADMIN_DATABASE_URL and SUPABASE_JWT_SECRET must be set to run the search tests',
  );
}

const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });

const orgId = randomUUID();
const otherOrgId = randomUUID();
const managerId = randomUUID();
const waiterId = randomUUID();
const cashierId = randomUUID();
const foreignUserId = randomUUID();

let managerToken = '';
let cashierToken = '';
let waiterToken = '';

/** A tag no other fixture in the suite uses, so a search for it is ours alone. */
const TAG = `zsrch${randomUUID().slice(0, 6)}`;

const ourIngredientId = randomUUID();
const foreignIngredientId = randomUUID();
const supplierId = randomUUID();
const foreignSupplierId = randomUUID();
const purchaseOrderId = randomUUID();

// Literal ids, so the prefix/substring assertion below controls its own hex.
const ORDER_A = 'aaaa1111-2222-4333-8444-555566667777';
const ORDER_B = 'bbbb8888-9999-4aaa-8bbb-ccccddddeeee';

const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
const asCashier = () => ({ Authorization: `Bearer ${cashierToken}` });
const asWaiter = () => ({ Authorization: `Bearer ${waiterToken}` });

/** Matches the seeded member emails (srch-mgr-…@dev.local), which TAG does not. */
const EMAIL_TERM = 'srch-';

interface Hit {
  kind: string;
  id: string;
  label: string;
  detail: string | null;
}

async function search(term: string, headers = asManager(), query = ''): Promise<Hit[]> {
  const res = await request(app)
    .get(`/api/search?q=${encodeURIComponent(term)}${query}`)
    .set(headers);
  expect(res.status).toBe(200);
  return res.body.results as Hit[];
}

const idsOf = (hits: Hit[], kind: string) => hits.filter((h) => h.kind === kind).map((h) => h.id);

beforeAll(async () => {
  for (const [id, label] of [
    [orgId, 'Search Org'],
    [otherOrgId, 'Other Search Org'],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES (${id}::uuid, ${label}, ${`srch-${id.slice(0, 8)}`}, 'enterprise')`;
  }

  for (const [id, prefix, role, org] of [
    [managerId, 'srch-mgr', 'branch_manager', orgId],
    [cashierId, 'srch-csh', 'cashier', orgId],
    [waiterId, 'srch-wtr', 'waiter', orgId],
    [foreignUserId, 'srch-alien', 'owner', otherOrgId],
  ] as const) {
    await admin.$executeRaw`INSERT INTO public.users (id, email) VALUES (${id}::uuid, ${`${prefix}-${id.slice(0, 8)}@dev.local`})`;
    await admin.$executeRaw`INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES (${org}::uuid, ${id}::uuid, ${role})`;
  }

  const sign = (sub: string) =>
    jwt.sign({ sub, aud: 'authenticated', role: 'authenticated' }, JWT_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
  managerToken = sign(managerId);
  cashierToken = sign(cashierId);
  waiterToken = sign(waiterId);

  // --- one of each kind, all carrying TAG ---------------------------------
  await admin.$executeRaw`
    INSERT INTO public.sellable_items (organization_id, name, sku, price)
    VALUES (${orgId}::uuid, ${`شاورما ${TAG} الخاصة`}, ${`SKU-${TAG}`}, 987.65)`;

  await admin.$executeRaw`
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (${ourIngredientId}::uuid, ${orgId}::uuid, ${`طحين ${TAG}`}, 'kg')`;

  await admin.$executeRaw`
    INSERT INTO public.suppliers (id, organization_id, name, contact_name)
    VALUES (${supplierId}::uuid, ${orgId}::uuid, ${TAG}, 'أبو علي')`;

  await admin.$executeRaw`
    INSERT INTO public.printers (organization_id, name, role, host)
    VALUES (${orgId}::uuid, ${`مطبخ ${TAG}`}, 'kitchen', '192.168.44.44')`;

  await admin.$executeRaw`
    INSERT INTO public.purchase_orders (id, organization_id, supplier_id, status)
    VALUES (${purchaseOrderId}::uuid, ${orgId}::uuid, ${supplierId}::uuid, 'draft')`;

  for (const id of [ORDER_A, ORDER_B]) {
    await admin.$executeRaw`
      INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount)
      VALUES (${id}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 'completed', 42.00)`;
  }

  // --- the same names, in somebody else's restaurant -----------------------
  // Identical to ours on purpose: a foreign row called something different
  // would never have matched, so hiding it would prove nothing.
  await admin.$executeRaw`
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (${foreignIngredientId}::uuid, ${otherOrgId}::uuid, ${`طحين ${TAG}`}, 'kg')`;
  await admin.$executeRaw`
    INSERT INTO public.suppliers (id, organization_id, name)
    VALUES (${foreignSupplierId}::uuid, ${otherOrgId}::uuid, ${TAG})`;
  await admin.$executeRaw`
    INSERT INTO public.sellable_items (organization_id, name, price)
    VALUES (${otherOrgId}::uuid, ${`شاورما ${TAG} الخاصة`}, 10.00)`;

  // --- names built out of LIKE syntax --------------------------------------
  for (const name of [`${TAG}_MILD`, `${TAG}XMILD`, `${TAG} 100% حار`]) {
    await admin.$executeRaw`
      INSERT INTO public.raw_inventory_items (organization_id, name, unit_of_measure)
      VALUES (${orgId}::uuid, ${name}, 'g')`;
  }

  // --- one loud kind: more matching ingredients than the whole response ----
  await admin.$executeRaw`
    INSERT INTO public.raw_inventory_items (organization_id, name, unit_of_measure)
    SELECT ${orgId}::uuid, ${`${TAG} حشو رقم `} || g, 'g' FROM generate_series(1, 25) AS g`;
});

afterAll(async () => {
  // Scoped to the two organizations this suite created, by id — never a blanket
  // delete.
  for (const org of [orgId, otherOrgId]) {
    await admin.$executeRaw`DELETE FROM public.purchase_orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.orders WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.printers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.suppliers WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.raw_inventory_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.sellable_items WHERE organization_id = ${org}::uuid`;
    await admin.$executeRaw`DELETE FROM public.organization_memberships WHERE organization_id = ${org}::uuid`;
  }
  await admin.$executeRaw`DELETE FROM public.users WHERE id IN (${managerId}::uuid, ${cashierId}::uuid, ${foreignUserId}::uuid)`;
  await admin.$executeRaw`DELETE FROM public.organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe('the fixture itself', () => {
  it('actually seeded the noisy kind', async () => {
    // The generate_series above is the kind of INSERT that silently writes zero
    // rows; every fairness assertion below would then pass by accident.
    const [{ count }] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM public.raw_inventory_items
       WHERE organization_id = ${orgId}::uuid AND name LIKE ${`${TAG} حشو رقم %`}`;
    expect(Number(count)).toBe(25);
  });
});

describe('finding things', () => {
  it('finds every kind of record from one box', async () => {
    const hits = await search(TAG);
    const kinds = new Set(hits.map((h) => h.kind));

    // A search that only ever reached one table would still look like it works.
    for (const kind of ['menu_item', 'ingredient', 'supplier', 'purchase_order', 'printer']) {
      expect(kinds).toContain(kind);
    }
  });

  it('finds a colleague by email', async () => {
    const hits = await search('srch-csh');
    expect(idsOf(hits, 'member')).toContain(cashierId);
  });

  it('matches part of a name, not just the whole of it', async () => {
    const hits = await search(TAG);
    // The menu item is "شاورما <TAG> الخاصة" — the term is in the middle.
    expect(hits.some((h) => h.kind === 'menu_item' && h.label.includes(TAG))).toBe(true);
  });

  it('puts an exact match first, across kinds', async () => {
    // The supplier is named exactly TAG; the menu item merely contains it, and
    // menu items are otherwise listed before suppliers. Ordering by kind alone
    // would bury the thing that was typed in full.
    const hits = await search(TAG);
    expect(hits[0].kind).toBe('supplier');
    expect(hits[0].id).toBe(supplierId);
  });

  it('answers a cashier with nothing, because a cashier has one page', async () => {
    // This test used to read "answers a cashier too — this is navigation, not
    // a privilege", and asserted hits.length > 0. That premise is what made
    // the search box a way around the roles: it returned records from pages
    // the caller could not open, including colleagues' emails. Navigation to
    // somewhere you may not go is not navigation.
    const hits = await search(TAG, asCashier());
    expect(hits).toEqual([]);
  });

  it('carries no money, for any role', async () => {
    // The menu item was seeded at 987.65. Search is open to a cashier, and the
    // margin pages are gated for a reason; a price arriving through the search
    // box would be a hole in that gate nobody would think to look for.
    const res = await request(app).get(`/api/search?q=${TAG}`).set(asCashier());
    expect(JSON.stringify(res.body)).not.toContain('987.65');
    for (const hit of res.body.results as Hit[]) {
      expect(Object.keys(hit).sort()).toEqual(['detail', 'id', 'kind', 'label']);
    }
  });
});

describe('the tenant boundary', () => {
  it('never returns another restaurant\'s row, even with an identical name', async () => {
    const hits = await search(TAG);

    // Positive half first: if ours were missing too, "the foreign one is
    // absent" would be true and meaningless.
    expect(idsOf(hits, 'ingredient')).toContain(ourIngredientId);
    expect(idsOf(hits, 'supplier')).toContain(supplierId);

    expect(idsOf(hits, 'ingredient')).not.toContain(foreignIngredientId);
    expect(idsOf(hits, 'supplier')).not.toContain(foreignSupplierId);
  });

  it('the foreign rows really are findable by name — the fixture is not inert', async () => {
    // Read as the superuser, outside RLS: both organizations have a row with
    // this exact name. So the absence above is RLS doing its job, not a typo in
    // the seed.
    const rows = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM public.raw_inventory_items WHERE name = ${`طحين ${TAG}`}`;
    expect(rows.map((r) => r.id).sort()).toEqual([ourIngredientId, foreignIngredientId].sort());
  });

  it('does not leak a colleague from another restaurant', async () => {
    const hits = await search('srch-alien');
    expect(idsOf(hits, 'member')).not.toContain(foreignUserId);
    expect(hits).toHaveLength(0);
  });
});

describe('LIKE syntax is text, not syntax', () => {
  it('finds an underscore where an underscore was typed', async () => {
    const hits = await search(`${TAG}_MILD`);
    const labels = hits.map((h) => h.label);
    expect(labels).toContain(`${TAG}_MILD`);
    // Unescaped, "_" matches any single character and would drag in the X.
    expect(labels).not.toContain(`${TAG}XMILD`);
  });

  it('treats a per-cent sign as a per-cent sign', async () => {
    // Nothing is named with a literal "%MILD", so the correct answer is
    // nothing. Unescaped, "%MILD" would match both of the rows above.
    const hits = await search(`%MILD`);
    expect(hits).toHaveLength(0);

    // And the row that genuinely contains a per-cent sign is still findable.
    const real = await search('100%');
    expect(real.some((h) => h.label === `${TAG} 100% حار`)).toBe(true);
  });

  it('a lone wildcard does not return the restaurant', async () => {
    const hits = await search('%%');
    expect(hits).toHaveLength(0);
  });
});

describe('an order by its number', () => {
  it('finds it from the number written on the receipt', async () => {
    const hits = await search('#aaaa1111');
    expect(idsOf(hits, 'order')).toContain(ORDER_A);
  });

  it('works without the hash too', async () => {
    const hits = await search('aaaa1111');
    expect(idsOf(hits, 'order')).toContain(ORDER_A);
  });

  it('matches an id by its START, not by any hex that appears in it', async () => {
    // "2222" sits in the middle of ORDER_A. Substring-matching a uuid means
    // almost every order matches almost every short term, and the order list
    // becomes noise that hides everything else.
    const hits = await search('2222');
    expect(idsOf(hits, 'order')).not.toContain(ORDER_A);
    expect(idsOf(hits, 'order')).not.toContain(ORDER_B);
  });
});

describe('no single kind may fill the answer', () => {
  it('still shows the supplier behind twenty-five matching ingredients', async () => {
    const hits = await search(TAG);

    // 25 ingredients match and the default response holds 20. Without a
    // per-kind cap they would be the entire answer.
    expect(idsOf(hits, 'ingredient').length).toBeLessThanOrEqual(8);
    expect(idsOf(hits, 'supplier')).toContain(supplierId);
    expect(hits.some((h) => h.kind === 'printer')).toBe(true);
  });
});

describe('what the box does before there is a question', () => {
  it('says nothing rather than erroring on the first keystroke', async () => {
    const res = await request(app).get('/api/search?q=a').set(asManager());
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    // The client needs to know why it got nothing, to say "keep typing".
    expect(res.body.min_length).toBe(2);
  });

  it('is not an error to ask for nothing', async () => {
    const res = await request(app).get('/api/search').set(asManager());
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('ignores whitespace around the term', async () => {
    const hits = await search(`   ${TAG}   `);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('honours an explicit limit', async () => {
    const hits = await search(TAG, asManager(), '&limit=3');
    expect(hits).toHaveLength(3);
  });

  it('requires authentication', async () => {
    expect((await request(app).get(`/api/search?q=${TAG}`)).status).toBe(401);
  });
});

/**
 * The search box was the way around the roles.
 *
 * Every admin route was reachable by any signed-in user — only the SIDEBAR
 * differed — and /api/search had no role gate at all, on the argument that
 * "search is navigation" and returns no money. Money was never the only thing
 * worth protecting. A waiter typing three letters could retrieve every
 * colleague's email address and role, the restaurant's suppliers, the purchase
 * orders placed with them, and printers by host:port — addresses on the
 * restaurant's own network.
 *
 * None of those pages are in a waiter's sidebar. The gate is now the role, on
 * the server, from the caller's membership.
 */
describe('search is scoped to what the role may open', () => {
  it('a waiter finds the menu and their orders', async () => {
    // The positive half FIRST. Without it, every "must not contain" below is
    // satisfied by a search that returns nothing at all, and the whole block
    // would pass while the feature was broken.
    const hits = await search(TAG, asWaiter());
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.kind)).toContain('menu_item');
  });

  it('a waiter cannot retrieve colleagues, suppliers, purchase orders or printers', async () => {
    const hits = await search(TAG, asWaiter());
    const kinds = new Set(hits.map((h) => h.kind));

    expect(kinds.has('member')).toBe(false);
    expect(kinds.has('supplier')).toBe(false);
    expect(kinds.has('purchase_order')).toBe(false);
    expect(kinds.has('printer')).toBe(false);
  });

  it('a waiter cannot look colleagues up by email', async () => {
    /**
     * Searched by an EMAIL FRAGMENT, not by TAG.
     *
     * The first version searched TAG and asserted no '@dev.local' came back —
     * and passed instantly, because the fixture's member emails do not contain
     * TAG at all. It proved that a search which never returns members returns
     * no members. The manager half is what exposed it: the same term produced
     * no `member` kind for a manager either.
     */
    const managerHits = await search(EMAIL_TERM, asManager(), '&limit=50');
    expect(managerHits.some((h) => h.kind === 'member')).toBe(true);

    const res = await request(app)
      .get(`/api/search?q=${EMAIL_TERM}&limit=50`)
      .set(asWaiter());
    expect((res.body.results as Hit[]).some((h) => h.kind === 'member')).toBe(false);
    // Not just "no member rows" — no address anywhere in the response, which
    // also catches one arriving as another kind's detail line.
    expect(JSON.stringify(res.body)).not.toContain('@dev.local');
  });

  it('a manager still finds what a waiter may not', async () => {
    // The gate must not be a wall: if this fails, the fix broke the feature for
    // the people whose job it is.
    //
    // limit=50 deliberately — the default is 20, and with seven kinds of up to
    // eight rows each, ordered with printers last, a manager's results are
    // truncated long before printers appear. On the default this would be a
    // test of the page size wearing the costume of a permissions test.
    //
    // Asserted on the three kinds the fixture actually produces for TAG.
    // Including `member` here was the mistake that exposed the vacuous test
    // above: no member email contains TAG, so nobody finds one, gate or no gate.
    const kinds = new Set((await search(TAG, asManager(), '&limit=50')).map((h) => h.kind));
    for (const kind of ['supplier', 'purchase_order', 'printer']) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it('a cashier finds nothing, because a cashier has one page and it is the till', async () => {
    const res = await request(app).get(`/api/search?q=${TAG}`).set(asCashier());
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});
