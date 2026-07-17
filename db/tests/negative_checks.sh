#!/usr/bin/env bash
# ============================================================================
# Negative checks — runs as mosaiz_app_user via PG* environment variables.
# Every statement below MUST be rejected by the database. If any of them
# succeeds, that is an RLS/permission hole: fail the build.
# Run order: after rls_verification.sql (relies on the cccc... identity),
# before admin_checks.sql (which asserts the eeee... rollback).
# ============================================================================
set -u

fail=0

expect_reject() {
    local desc="$1" sql="$2"
    if psql -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1; then
        echo "NOT REJECTED (security hole): $desc"
        fail=1
    else
        echo "rejected as expected: $desc"
    fi
}

expect_reject "direct INSERT into users (no INSERT policy — pipeline only)" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.users (id, email)
     VALUES ('99999999-9999-4999-8999-999999999999', 'rogue@ci.test');"

expect_reject "direct INSERT into organizations (tenant bootstrap barrier)" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.organizations (name, slug) VALUES ('Rogue', 'rogue-org');"

expect_reject "provisioning with invalid plan_tier (CHECK constraint must propagate)" \
    "CALL app.provision_new_tenant(
         'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'atomic@ci.test',
         'Atomic Test', 'atomic-test', 'platinum');"

expect_reject "duplicate org slug through provisioning (UNIQUE must propagate)" \
    "CALL app.provision_new_tenant(
         'ffffffff-ffff-4fff-8fff-ffffffffffff', 'dup@ci.test',
         'Dup Slug', 'ci-bistro-cairo', 'basic');"

# 0009. The app role CAN insert raw items (proven positively in
# inventory_fifo_verification section 5), so this can only be the CHECK.
expect_reject "raw item with a negative reorder_threshold (CHECK must reject)" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.raw_inventory_items
         (organization_id, name, unit_of_measure, reorder_threshold)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'Negative Threshold', 'kg', -1);"

exit "$fail"
