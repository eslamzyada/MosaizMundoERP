# Composable tenancy: modules, plans and entitlements

Research and design notes for making Mosaiz Mundo adjustable per tenant.
Written after 0037 shipped the module system. **The plan layer shipped in
0044** — this document is the design it was built from, and §4–§5 now describe
what exists rather than what is proposed. Two things changed in the building:

- The matrix gained the three modules that shipped after this was written:
  `labour` and `reservations` at standard, `public_ordering` at premium.
- `app.org_has_module`'s fallback had to change too. 0037 made "no row" mean
  the catalogue default, which after 0044 would have handed the premium shelf
  to every restaurant created tomorrow — nobody would need to switch anything
  on, so the ceiling would never be asked. An absent row is now the default
  INTERSECTED with the plan; an explicit row still wins outright, which is
  where both tenant choice and grandfathering live.

**Read this before adding a module, a plan, or anything that gates a feature.**

---

## 1. "Composable ERP" means two different things — we want the smaller one

The industry term describes assembling an enterprise system from **Packaged
Business Capabilities**: independently deployed services from different vendors,
joined by APIs and a data fabric, so a company can replace its billing engine
without touching its inventory engine. That is a buying strategy for
enterprises escaping a monolith, and it is *not* what a single-product
multi-tenant SaaS needs.

For us, "composable" means exactly two mechanisms:

| Mechanism | Question it answers | Where it lives |
|---|---|---|
| **Entitlement** | Does this tenant get this capability? | `organization_modules` (0037) |
| **Configuration** | Within a capability, how does this tenant want it? | `user_preferences`, `organization_branding`, `rating_criteria`, void/write-off reasons |

Nothing here loads code at runtime, and nothing is a plugin. The product is one
codebase; what varies is which parts a restaurant is entitled to and how those
parts are configured. Resist any proposal to add a third mechanism.

---

## 2. Three gates that get confused, and must not be

These are independent, and they run in this order:

1. **Entitlement** — *the tenant bought this.* Permanent, commercial, per
   organization. → `app.org_has_module()`.
2. **Permission** — *this user may do it.* Permanent, organisational, per role.
   → 0010's RESTRICTIVE role policies, `requireRole`.
3. **Feature flag** — *this code is ready.* Temporary, engineering, per
   deployment. → we have none, and should keep it that way until a risky
   rollout genuinely needs one.

Conflating 1 and 2 leaks paid features to people who should not have them, or
blocks people who should. Conflating 1 and 3 is the classic rot: a permanent
"flag" that encodes pricing, which nobody dares delete and which no longer
means what its name says. Healthy codebases keep well under 20–30 live flags;
entitlements are not counted among them because they are data, not code.

**Order matters.** Entitlement first: a cashier hitting a purchasing endpoint in
a restaurant that does not buy purchasing should be told the restaurant does not
run purchasing, not that their role is insufficient. The second answer sends
them to their manager for something the manager also cannot give them.

---

## 3. What a restaurant ERP is made of, and what we are missing

Every current buyer's guide converges on the same core: **POS and payments**,
**inventory and purchasing** (stock counts, vendor orders, recipe costing, waste),
and **labour and scheduling** (shift planning, time clocks, compliance).

Mapped against what exists here:

| Capability | State | Module key |
|---|---|---|
| POS, orders, menu | Built. Core — never switchable | — |
| Inventory, batches, FIFO cost | Built | `inventory` |
| Recipes / BOM costing | Built | `recipes` |
| Suppliers and purchase orders | Built | `purchasing` |
| Stocktake and reconciliation | Built | `stocktake` |
| Waste and staff meals | Built | `waste` |
| Employee appraisal | Built | `performance` |
| Printers | Built | `printers` |
| Menu approval cycle | Built | `menu_approval` |
| BI dashboard | Built | `insights` |
| PDF / XLSX export | Built | `exports` |
| Labour: shifts, time clocks, wages | Built (0038, 0042) | `labour` |
| Table reservations, seating | Built (0039, 0043) | `reservations` |
| Customer-facing online ordering | Built (0040) | `public_ordering` |

All three of the gaps this section originally named have since been closed.
Labour was called the significant one and was built first, for the reason given
at the time: scheduling and time clocks are the third pillar beside sales and
stock, because labour is the other half of a restaurant's controllable cost. It
now carries effective-dated wages (0042), so the service report can cost a shift
at the rate that applied *then* rather than the rate today.

Nothing in the buyer's-guide core is outstanding. The next capability is a
judgement about this product rather than a gap against the category.

---

## 4. Plans (0044, shipped)

`organizations.plan_tier` has existed since 0001 with four values and is read by
nothing. The module system deliberately shipped without touching it, so that
entitlement worked before pricing was involved. This is the design to add.

### The packaging model

Good / Better / Best, which is about *bundling*, not about what drives price.
Keep the two separate: packaging says what is included, pricing says what the
bill is computed from. The value metric here is the **branch** — a restaurant
with four locations gets four times the value from the same feature set — so
tiers should gate capability while branch count drives price.

### Proposed matrix

| Module | basic | standard | premium | enterprise |
|---|:--:|:--:|:--:|:--:|
| POS, orders, menu (core) | ● | ● | ● | ● |
| `inventory` | ● | ● | ● | ● |
| `recipes` | — | ● | ● | ● |
| `purchasing` | — | ● | ● | ● |
| `stocktake` | — | ● | ● | ● |
| `waste` | — | ● | ● | ● |
| `printers` | ● | ● | ● | ● |
| `insights` | — | — | ● | ● |
| `exports` | — | — | ● | ● |
| `performance` | — | — | ● | ● |
| `labour` | — | ● | ● | ● |
| `reservations` | — | ● | ● | ● |
| `public_ordering` | — | — | ● | ● |
| `menu_approval` | — | — | — | ● |

`menu_approval` sits at the top on purpose: the two-person rule is a
multi-branch governance feature, and a single-owner café neither needs it nor
should pay for it. Note it is also the one module whose "off" state is not
absence but *self-approval* — see 0037's header.

### Rules the implementation must hold

- **A tenant may switch a module OFF at any tier, but may only switch it ON if
  the plan includes it.** Entitlement is a ceiling, not an assignment. Somebody
  who does not want الجرد should not be forced to look at it.
- **Fail closed.** An unknown plan, an unreadable plan, or a missing row grants
  nothing above `basic`. Never "allow on error" for a revenue-bearing gate.
- **Grandfather explicitly.** Existing tenants keep what they already have, in a
  backfilled row with a comment saying why — exactly as 0037's backfill did.
  A migration that silently removes a working feature breaks somebody's Tuesday.
- **A downgrade must not delete anything.** It removes the ability to write, not
  the record of what was written. This is the same per-command policy shape as
  0037: `FOR INSERT / UPDATE / DELETE`, never `FOR ALL`.

### The cache trap — our specific exposure

A downgrade that is not reflected in the cache lets a tenant keep paid features
until the TTL expires. We are exposed in two concrete places:

1. `/api/me` returns the module list. If that response is ever cached, a
   downgrade leaks until it expires.
2. `cacheKey()` (PR #84) keys by `organization_id` and `role` — **not** by plan
   or module state, so a cached payload computed while a module was on stays
   valid-looking after it goes off.

Therefore: **`app.set_module` and any future plan change must invalidate that
organization's cache namespace**, and module state must never be served from a
cached `/api/me`. Prefer no caching on this path at all — it is one indexed
lookup — over a TTL somebody has to reason about. This mirrors the existing rule
that money-shaped paths stay uncached.

---

## 5. What 0044 added

1. `modules.min_plan` (`basic` | `standard` | `premium` | `enterprise`) and a
   plan-ordering helper, so "included in this plan" is data rather than code.
2. `app.set_module` gains a plan check on the enable path — refusing with a
   distinct SQLSTATE so the API can answer 402/409 "your plan does not include
   this" rather than a generic 403.
3. A plan change procedure that is the only way `plan_tier` moves, which
   disables anything the new plan does not include, records why, and notifies
   the owner (0036 already provides delivery).
4. Cache invalidation on both paths.
5. `db/tests/plan_verification.sql`: a `basic` tenant cannot switch on
   `insights` by any route; a downgrade disables what it must and **changes no
   report about the past**; grandfathered tenants keep what they had.

---

## Sources

- [Featureflow — feature flags vs entitlements](https://www.featureflow.com/blog/feature-flags-vs-entitlements)
- [StackBE — entitlements over feature flags](https://stackbe.io/blog/entitlements-over-feature-flags/)
- [LaunchDarkly — reducing technical debt from flags](https://launchdarkly.com/docs/guides/flags/technical-debt)
- [Multi-Tenant SaaS Hub — subscription and plan enforcement](https://www.multi-tenant-saas.com/tenant-billing-usage-metering/subscription-and-plan-enforcement/)
- [WorkOS — developer's guide to multi-tenant architecture](https://workos.com/blog/developers-guide-saas-multi-tenant-architecture)
- [Stripe — SaaS pricing and packaging strategy](https://stripe.com/resources/more/saas-pricing-and-packaging-strategy)
- [Chargebee — grandfathering in SaaS pricing](https://www.chargebee.com/resources/glossaries/what-is-grandfathering/)
- [MarginEdge — tech for multi-location restaurants](https://www.marginedge.com/blog/6-best-tech-solutions-for-multi-location-restaurants)
- [Priority — composable ERP](https://www.priority-software.com/resources/composable-erp/)
