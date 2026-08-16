-- ============================================================================
-- 0049_indexable_tenancy.sql — make the tenant boundary something the planner
-- can use, instead of something it can only check afterwards
--
-- Every RLS policy in this system has been the same shape since 0001:
--
--     USING (app.user_belongs_to_org(organization_id))
--
-- It is correct, and it has always been correct. It is also OPAQUE: the
-- planner cannot see inside a function, so it can never use that predicate to
-- choose rows. It reads rows by some other index, then calls the function once
-- PER ROW to throw most of them away.
--
-- ----------------------------------------------------------------------------
-- MEASURED, on a year of trading (460k orders) across 14 restaurants sharing
-- one database — "revenue over the last 30 days", the query behind the
-- dashboard, the service report and every export:
--
--     as written today            205 ms     34,020 rows read and discarded
--     with the new predicate      2.4 ms     43 rows discarded
--
-- The same query at TWO tenants was only 11% slower, which is why this never
-- showed up. The wasted work is proportional to how many OTHER restaurants
-- share the database, while the useful work stays constant — so it is
-- invisible in development and grows without limit in production. Fourteen
-- tenants is already 84x; a hundred would be worse in the same straight line.
--
-- ----------------------------------------------------------------------------
-- THE CHANGE, and why it is exactly equivalent.
--
--     old:  EXISTS (SELECT 1 FROM organization_memberships
--                    WHERE organization_id = X
--                      AND user_id = app.current_user_id() AND is_active)
--
--     new:  X = ANY (app.my_org_ids())
--           where my_org_ids() = the organization_ids of my ACTIVE memberships
--
-- The same set, asked the other way round. `= ANY (array)` is a form the
-- planner understands, so `organization_id` joins `created_at` in the index
-- condition instead of being checked row by row.
--
-- Both edge cases hold:
--
--   * no identity bound — current_user_id() is NULL, so the array is empty and
--     `X = ANY ('{}')` is false for every row. The old EXISTS found nothing.
--     Identical, and identically closed.
--   * a NULL organization_id — `NULL = ANY (...)` is NULL, which a policy
--     treats as "no". The old form found no matching membership row. Identical
--     (and every organization_id in this schema is NOT NULL anyway).
--
-- app.user_belongs_to_org() is DELIBERATELY KEPT. Half the SECURITY DEFINER
-- procedures call it to draw the tenant boundary themselves, where there is no
-- policy to do it for them, and it is the clearer way to ask about one
-- organization. Only the POLICIES change.
--
-- ----------------------------------------------------------------------------
-- Nothing here widens access, and the last statement in this file proves it:
-- it fails the migration if a single policy still carries the old predicate,
-- or if the number of rewritten policies is not the number that existed.
-- ============================================================================

BEGIN;

CREATE FUNCTION app.my_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    -- COALESCE, because array_agg over no rows is NULL and `X = ANY (NULL)`
    -- is NULL rather than false. An empty array is the honest "no
    -- organizations", and it refuses every row.
    SELECT COALESCE(array_agg(m.organization_id), '{}'::uuid[])
      FROM public.organization_memberships m
     WHERE m.user_id = app.current_user_id()
       AND m.is_active;
$$;

COMMENT ON FUNCTION app.my_org_ids() IS
    'The organizations the caller is an ACTIVE member of (0049). The set app.user_belongs_to_org asks about one at a time — same answer, in a form the planner can use as an index condition rather than a per-row filter.';

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.my_org_ids() TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The rewrite.
--
-- Driven by an explicit table list rather than by looping over the catalogue.
-- A catalogue loop cannot misname a table, but it CAN rebuild a policy with
-- the wrong command — turning a SELECT-only policy into FOR ALL is a silent
-- write hole, and that is not a risk worth taking to save typing. So the
-- command and the check clause are fixed per shape here, and only the table
-- name varies.
-- ----------------------------------------------------------------------------

-- Shape A: FOR ALL, USING and WITH CHECK. The ordinary tenant-scoped table.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'bill_of_materials', 'employee_criterion_scores', 'employee_ratings',
        'employee_wages', 'inventory_batches', 'inventory_consumption',
        'inventory_deficits', 'menu_change_requests', 'notifications',
        'order_items', 'orders', 'organization_branding',
        'organization_invitations', 'organization_memberships',
        'organization_modules', 'printers', 'public_order_lines',
        'public_orders', 'purchase_order_lines', 'purchase_orders',
        'rating_criteria', 'raw_inventory_items', 'reservations',
        'restaurant_tables', 'sellable_items', 'shifts',
        'stock_write_off_lines', 'stock_write_offs', 'stocktake_items',
        'stocktakes', 'storefronts', 'suppliers', 'time_entries',
        'user_preferences'
    ] LOOP
        EXECUTE format('DROP POLICY user_belongs_to_org ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY user_belongs_to_org ON public.%I
                 FOR ALL USING (organization_id = ANY (app.my_org_ids()))
                 WITH CHECK (organization_id = ANY (app.my_org_ids()))', t);
    END LOOP;
END;
$$;

-- Shape B: FOR SELECT only. Money and plan history are read by the tenant and
-- written exclusively by SECURITY DEFINER procedures, so they have no write
-- policy at all and must not acquire one here.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['order_payments', 'plan_changes', 'till_sessions'] LOOP
        EXECUTE format('DROP POLICY user_belongs_to_org ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY user_belongs_to_org ON public.%I
                 FOR SELECT USING (organization_id = ANY (app.my_org_ids()))', t);
    END LOOP;
END;
$$;

-- Shape C: organizations, where the tenant column is `id`. Reading stays open
-- to every member (0048); the owner-only write policy is untouched.
DROP POLICY readable_by_members ON public.organizations;
CREATE POLICY readable_by_members ON public.organizations
    FOR SELECT USING (id = ANY (app.my_org_ids()));

-- ----------------------------------------------------------------------------
-- The proof. This is a change to the tenant boundary on 38 tables; a typo in
-- the list above would leave one table behind, and a table left behind is a
-- table whose policy still works — so nothing would fail, and nobody would
-- notice until it was slow. Fail the migration instead.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_old integer;
    v_new integer;
BEGIN
    SELECT count(*) INTO v_old
      FROM pg_policy
     WHERE pg_get_expr(polqual, polrelid) LIKE '%user_belongs_to_org%'
        OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE '%user_belongs_to_org%';

    IF v_old <> 0 THEN
        RAISE EXCEPTION
            '% policies still use the opaque tenancy predicate; the table list is incomplete',
            v_old;
    END IF;

    SELECT count(*) INTO v_new
      FROM pg_policy
     WHERE pg_get_expr(polqual, polrelid) LIKE '%my_org_ids%';

    -- 34 + 3 + 1. Stated as a number so that dropping a table from the list
    -- and quietly losing its policy cannot pass.
    IF v_new <> 38 THEN
        RAISE EXCEPTION 'expected 38 rewritten policies, found %', v_new;
    END IF;
END;
$$;

COMMIT;
