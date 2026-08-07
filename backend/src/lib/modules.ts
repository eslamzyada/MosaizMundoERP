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
  /** The cheapest plan that may switch this on (0044). */
  min_plan: string;
  /** Whether this tenant's plan reaches it — separate from whether it is on. */
  entitled: boolean;
  /** Kept from before plans existed, so the ceiling lets it through anyway. */
  grandfathered: boolean;
  sort_order: number;
}

/**
 * The catalogue with this organization's answer for each row.
 *
 * `enabled` is asked of app.org_has_module rather than computed here. It used
 * to be COALESCE(om.enabled, m.default_enabled), which was the same answer
 * until 0044 — after which an absent row means "the default, IF the plan
 * reaches it", and a reimplementation in SQL up here would drift from the
 * policy the moment either changed. The rule was always that the policy wins;
 * this makes it structural rather than aspirational.
 *
 * The LEFT JOIN stays for `grandfathered`, which has no row for most tenants:
 * a tenant that predates a module has no row at all, and an inner join would
 * silently drop every capability nobody has ever decided about.
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
           app.org_has_module(${organizationId}::uuid, m.key) AS enabled,
           m.min_plan,
           app.plan_includes(${organizationId}::uuid, m.key) AS entitled,
           COALESCE(om.grandfathered, false) AS grandfathered,
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

/**
 * Which plan this tenant is on (0044).
 *
 * Separate from readModules because the plan is one string and the catalogue
 * is thirteen rows: the sidebar needs the rows, and "you are on basic" needs
 * only this. Falls back to `basic` rather than to nothing — the same
 * fail-closed rule app.plan_rank applies, for the same reason.
 */
export async function readPlan(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ plan_tier: string }>>`
    SELECT o.plan_tier FROM public.organizations o WHERE o.id = ${organizationId}::uuid`;
  return rows[0]?.plan_tier ?? 'basic';
}
