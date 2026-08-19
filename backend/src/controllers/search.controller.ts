import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import {
  MIN_SEARCH_LENGTH,
  likeContains,
  likePrefix,
  normalizeSearchTerm,
  withoutHash,
} from '../lib/searchTerm';
import { searchKindsFor } from '../lib/searchScope';
import { resolveMembership } from '../middleware/requireRole';

/**
 * One search box over the whole system.
 *
 * WHY ONE RAW QUERY AND NOT SEVEN PRISMA CALLS.
 *
 * This runs on every keystroke. Under the one-transaction-per-request model a
 * request holds a single connection, so seven `findMany` calls are seven
 * sequential round trips on that one connection — the search box would get
 * slower the more of the system it covered, which is precisely backwards. One
 * UNION ALL is one round trip regardless of how many kinds are added to it.
 *
 * WHY IT IS STILL SAFE ACROSS TENANTS.
 *
 * Every branch reads through `req.tx`, so each one is filtered by its own
 * table's `user_belongs_to_org` policy exactly as a typed query would be. There
 * is no `organization_id = …` anywhere below, and there must not be: a WHERE
 * clause that duplicates RLS is a WHERE clause that can silently disagree with
 * it. The cross-tenant assertion in the test suite seeds a foreign row with an
 * IDENTICAL name, so it fails if this ever stops being true.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN.
 *
 * No money. A search hit carries a name, an id, and enough context to
 * recognise it — never a total or a cost. Search is readable by every role
 * including a cashier, and the finance pages are gated for a reason.
 */

/** The kinds of thing that can be found. Mirrored by the admin's target map. */
export const SEARCH_KINDS = [
  'menu_item',
  'ingredient',
  'supplier',
  'member',
  'purchase_order',
  'order',
  'printer',
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchHit {
  kind: SearchKind;
  id: string;
  label: string;
  detail: string | null;
}

/**
 * How many hits each kind may contribute.
 *
 * The cap is PER KIND rather than overall on purpose. A restaurant with forty
 * ingredients containing "طماطم" and one supplier called "طماطم مصر" would,
 * under a single overall limit, return forty ingredients and hide the supplier
 * — the one result that was probably being looked for. Capping each kind means
 * every kind that matches at all is represented.
 */
const PER_KIND = 8;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface RawHit {
  kind: string;
  id: string;
  label: string;
  detail: string | null;
  match_rank: number;
}

/**
 * GET /api/search?q=&limit=
 *
 * Open to every authenticated member: this is navigation, and RLS already
 * decides what there is to navigate to. A term shorter than
 * MIN_SEARCH_LENGTH answers 200 with nothing rather than 400 — the client
 * types into this box one character at a time, and an error on the first
 * keystroke is noise, not information.
 */
export async function globalSearch(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const term = normalizeSearchTerm(req.query.q);
  if (!term) {
    res.status(200).json({ results: [], min_length: MIN_SEARCH_LENGTH });
    return;
  }

  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  // `%` and `_` are escaped here, so a search for "%" looks for a per-cent
  // sign rather than matching everything.
  const anywhere = likeContains(term);
  const startsWith = likePrefix(term);
  const lowered = term.toLowerCase();

  // Ids are matched by PREFIX only. A uuid contains every hex digit somewhere,
  // so "ab" as a substring matches nearly every order ever taken; as a prefix
  // it matches the one whose number was written on the receipt.
  const idPrefix = likePrefix(withoutHash(term));

  try {
    /**
     * What this caller is allowed to find, decided here rather than by the
     * request. A membership that cannot be resolved gets an EMPTY scope, so a
     * caller with no role finds nothing instead of everything.
     */
    const membership = await resolveMembership(req);
    const allowedKinds = searchKindsFor(membership?.role);

    if (allowedKinds.length === 0) {
      // A cashier has one page and it is the till. Answering with an empty
      // list is the honest result, and it costs no query at all.
      res.status(200).json({ results: [] });
      return;
    }

    const rows = await req.tx.$queryRaw<RawHit[]>`
      WITH hits AS (
        (SELECT 'menu_item'::text AS kind,
                1 AS kind_order,
                si.id::text AS id,
                si.name AS label,
                si.sku AS detail,
                row_number() OVER (ORDER BY length(si.name), si.name) AS seq
           FROM public.sellable_items si
          WHERE si.name ILIKE ${anywhere}
             OR si.sku ILIKE ${anywhere}
          ORDER BY seq
          LIMIT ${PER_KIND})
        UNION ALL
        (SELECT 'ingredient',
                2,
                ri.id::text,
                ri.name,
                ri.unit_of_measure,
                row_number() OVER (ORDER BY ri.is_active DESC, length(ri.name), ri.name) AS seq
           FROM public.raw_inventory_items ri
          WHERE ri.name ILIKE ${anywhere}
          ORDER BY seq
          LIMIT ${PER_KIND})
        UNION ALL
        (SELECT 'supplier',
                3,
                su.id::text,
                su.name,
                COALESCE(su.contact_name, su.phone),
                row_number() OVER (ORDER BY su.is_active DESC, length(su.name), su.name) AS seq
           FROM public.suppliers su
          WHERE su.name ILIKE ${anywhere}
             OR su.contact_name ILIKE ${anywhere}
             OR su.phone ILIKE ${anywhere}
          ORDER BY seq
          LIMIT ${PER_KIND})
        UNION ALL
        (SELECT 'member',
                4,
                m.user_id::text,
                u.email,
                m.role,
                row_number() OVER (ORDER BY m.is_active DESC, u.email) AS seq
           FROM public.organization_memberships m
           JOIN public.users u ON u.id = m.user_id
          WHERE u.email ILIKE ${anywhere}
          ORDER BY seq
          LIMIT ${PER_KIND})
        UNION ALL
        (SELECT 'purchase_order',
                5,
                po.id::text,
                '#' || left(po.id::text, 8),
                su2.name,
                row_number() OVER (ORDER BY po.created_at DESC) AS seq
           FROM public.purchase_orders po
           JOIN public.suppliers su2 ON su2.id = po.supplier_id
          WHERE po.id::text LIKE ${idPrefix}
             OR po.notes ILIKE ${anywhere}
             OR su2.name ILIKE ${anywhere}
          ORDER BY seq
          LIMIT ${PER_KIND})
        UNION ALL
        (SELECT 'order',
                6,
                o.id::text,
                '#' || left(o.id::text, 8),
                to_char(o.created_at, 'YYYY-MM-DD'),
                row_number() OVER (ORDER BY o.created_at DESC) AS seq
           FROM public.orders o
          WHERE o.id::text LIKE ${idPrefix}
             OR o.note ILIKE ${anywhere}
          ORDER BY seq
          LIMIT ${PER_KIND})
        UNION ALL
        (SELECT 'printer',
                7,
                pr.id::text,
                pr.name,
                pr.host || ':' || pr.port,
                row_number() OVER (ORDER BY pr.is_active DESC, pr.name) AS seq
           FROM public.printers pr
          WHERE pr.name ILIKE ${anywhere}
             OR pr.host ILIKE ${anywhere}
          ORDER BY seq
          LIMIT ${PER_KIND})
      )
      SELECT kind,
             id,
             label,
             detail,
             -- An exact name beats a name that starts with the term, which
             -- beats one that merely contains it. Without this, typing a menu
             -- item's full name can leave it below a longer item that happens
             -- to sort earlier.
             CASE WHEN lower(label) = ${lowered} THEN 0
                  WHEN label ILIKE ${startsWith} THEN 1
                  ELSE 2 END AS match_rank
        FROM hits
       -- The role gate. Computed on the server from this caller's membership,
       -- never from anything the request supplied. A waiter searching three
       -- letters used to get colleagues' emails and roles, supplier names,
       -- purchase orders and printer host:port — none of which is on a page
       -- they can open.
       WHERE kind = ANY(${allowedKinds})
       ORDER BY match_rank, kind_order, seq
       LIMIT ${limit}
    `;

    res.status(200).json({
      results: rows.map(({ kind, id, label, detail }) => ({
        kind: kind as SearchKind,
        id,
        label,
        detail,
      })),
    });
  } catch (err) {
    logger.error('search failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
