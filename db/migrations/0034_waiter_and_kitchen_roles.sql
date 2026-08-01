-- ============================================================================
-- Migration 0034: The two roles the floor actually has
-- Mosaiz Mundo ERP
--
-- Until now a restaurant's people were owner, regional_manager, branch_manager,
-- accountant, cashier and staff. Two of the jobs that exist in every restaurant
-- had no name: the person working the floor, and the person on the pass.
--
-- Both were being expressed as `staff`, which is why the back office shows a
-- waiter eleven pages they have no business in and shows the kitchen the same
-- eleven. A role that means "not one of the others" cannot be the basis of a
-- screen that means anything.
--
-- ----------------------------------------------------------------------------
-- WAITER SELLS. KITCHEN DOES NOT WRITE AT ALL.
--
-- A waiter opening a tab and adding items to it IS a sale in progress, so
-- `waiter` joins user_can_sell beside cashier and staff. Nothing else changes
-- for them: they cannot receive stock, edit the catalog, or read the books.
--
-- `kitchen` joins NO write list, and that is the whole design rather than an
-- omission. Every SELECT in this schema is already open to members of the
-- organization — the 0010 policies restrict writes — so a kitchen membership
-- can read the orders, the menu and the recipes it needs and can change none of
-- them. Adding a capability the role does not yet need would be inventing a
-- workflow rather than naming a job.
--
-- What the kitchen cannot yet do is mark a ticket prepared: there is no such
-- state on order_items, only fired_at. That is a real gap and deliberately not
-- filled here — a new state on a table the checkout procedures write is a
-- change to the sale path, and it deserves its own migration and its own
-- assertions rather than riding along with a CHECK constraint edit.
--
-- ----------------------------------------------------------------------------
-- WHY BOTH CONSTRAINTS.
--
-- The role vocabulary is written down twice: once on the membership a person
-- holds, and once on the invitation that offers it. Extending one and not the
-- other produces a role that can be granted and never invited, or invited and
-- never granted — and the failure appears at the far end of a sign-up flow,
-- which is the worst place to discover it.
--
-- Depends on: 0010 (role helpers), 0011 (memberships), 0012 (invitations)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The vocabulary.
--
--    Dropped and recreated rather than altered: a CHECK constraint has no ALTER
--    that adds a value, and recreating it re-validates every existing row —
--    which is the point. If any row somehow held a role outside the old list,
--    this is where that is discovered rather than carried forward.
-- ----------------------------------------------------------------------------
ALTER TABLE public.organization_memberships
    DROP CONSTRAINT organization_memberships_role_check;

ALTER TABLE public.organization_memberships
    ADD CONSTRAINT organization_memberships_role_check
    CHECK (role = ANY (ARRAY[
        'owner', 'regional_manager', 'branch_manager',
        'accountant', 'cashier', 'waiter', 'kitchen', 'staff'
    ]));

ALTER TABLE public.organization_invitations
    DROP CONSTRAINT organization_invitations_role_check;

ALTER TABLE public.organization_invitations
    ADD CONSTRAINT organization_invitations_role_check
    CHECK (role = ANY (ARRAY[
        'owner', 'regional_manager', 'branch_manager',
        'accountant', 'cashier', 'waiter', 'kitchen', 'staff'
    ]));

-- ----------------------------------------------------------------------------
-- 2. What a waiter may do.
--
--    CREATE OR REPLACE, so every policy that calls this picks up the new list
--    without being touched. The role lists living in exactly one place is what
--    makes this a four-line change instead of an audit of thirty policies.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.user_can_sell(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT app.user_has_org_role(
        target_organization_id,
        ARRAY['owner', 'regional_manager', 'branch_manager', 'cashier', 'waiter', 'staff']
    );
$$;

COMMENT ON FUNCTION app.user_can_sell(uuid) IS
    'May ring up a sale and the stock movement it causes: management, cashier, waiter and staff. Excludes accountant (read-only) and kitchen (writes nothing).';

-- user_can_administer is deliberately UNCHANGED. Neither new role administers,
-- and the comment is refreshed so the exclusion list is not silently stale.
COMMENT ON FUNCTION app.user_can_administer(uuid) IS
    'Operational writes: receiving stock, stocktakes, catalog and recipe edits. Excludes accountant (read-only), cashier, waiter, kitchen and staff.';

COMMIT;
