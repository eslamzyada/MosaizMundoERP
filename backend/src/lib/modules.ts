import { Prisma } from '@prisma/client';

/**
 * Which capabilities a tenant runs (0037).
 *
 * The database is the enforcement point — a RESTRICTIVE policy per module-owned
 * table — and nothing in this file changes that. What this adds is legibility:
 * a policy refusal arrives as an opaque privilege error, and "internal server
 * error" would send a manager to read logs about a subscription setting they
 * could have fixed in the الوحدات screen.
 *
 * So: read the enabled set once per request that needs it, and answer 409 with
 * the module's name BEFORE the database refuses. If this check and the policy
 * ever disagree, the policy wins — which is the right way round.
 */

export interface ModuleRow {
  key: string;
  name_ar: string;
  description_ar: string;
  depends_on: string[];
  enforced_in: string;
  enabled: boolean;
  sort_order: number;
}

/**
 * The catalogue with this organization's answer for each row.
 *
 * LEFT JOIN with a COALESCE onto the catalogue default, not an inner join: a
 * tenant that predates a module has no row for it, and inner-joining would
 * silently report a brand-new capability as switched off for every existing
 * restaurant.
 */
export async function readModules(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<ModuleRow[]> {
  // RLS already keeps this to organizations the caller belongs to — but a user
  // may belong to more than one (getMe resolves the earliest), and without the
  // explicit organization_id this join would return the catalogue once per
  // membership. The duplicate would not leak anything; it would just make the
  // sidebar disagree with itself.
  return tx.$queryRaw<ModuleRow[]>`
    SELECT m.key,
           m.name_ar,
           m.description_ar,
           m.depends_on,
           m.enforced_in,
           COALESCE(om.enabled, m.default_enabled) AS enabled,
           m.sort_order
      FROM public.modules m
      LEFT JOIN public.organization_modules om
             ON om.module_key = m.key
            AND om.organization_id = ${organizationId}::uuid
     ORDER BY m.sort_order`;
}

/** Just the keys that are on — what the client needs to build a sidebar. */
export async function enabledModules(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<string[]> {
  const rows = await readModules(tx, organizationId);
  return rows.filter((r) => r.enabled).map((r) => r.key);
}
