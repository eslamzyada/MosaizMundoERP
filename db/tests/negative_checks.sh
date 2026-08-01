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

# --- 0033. Rating criteria and per-criterion scores -------------------------
# IDENTITIES: this script runs SECOND, straight after rls_verification, so the
# only things that exist are ci-bistro-cairo and its owner cccccccc. The cogs
# fixture with its cashier is two hundred lines of CI away. Referencing it here
# would make every check below pass for the wrong reason — rejected because the
# row does not exist, which proves nothing about the policy.
#
# The two checks that genuinely need a second identity (a cashier writing to the
# rubric) or a second organization (the composite foreign key) therefore live in
# rating_criteria_verification.sql, which runs after both fixtures.

expect_reject "criterion with a zero weight (would be scored but never counted)"     "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.rating_criteria (organization_id, name, weight)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'Zero Weight', 0);"

expect_reject "criterion with a weight above the ceiling"     "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.rating_criteria (organization_id, name, weight)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'Heavy', 99);"

expect_reject "criterion with a blank name"     "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.rating_criteria (organization_id, name)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             '   ');"

# Derived from a row that already exists rather than written out as a literal:
# this script passes SQL to psql on a COMMAND LINE, and a non-ASCII literal
# arrives re-encoded on Windows. It then matches nothing, the insert succeeds,
# and the check reports a hole that is not there — which is exactly what
# happened the first time this was written. The Arabic form of this assertion
# lives in rating_criteria_verification.sql, which psql reads from a file.
expect_reject "criterion name differing from an existing one only by spacing"     "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.rating_criteria (organization_id, name)
     SELECT c.organization_id, '  ' || c.name || '  '
       FROM public.rating_criteria c
       JOIN public.organizations o ON o.id = c.organization_id
      WHERE o.slug = 'ci-bistro-cairo'
      ORDER BY c.sort_order LIMIT 1;"

expect_reject "score of 6 on a 1-5 scale"     "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.employee_criterion_scores
         (organization_id, employee_id, criterion_id, period_month, score)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
             (SELECT c.id FROM public.rating_criteria c
                JOIN public.organizations o ON o.id = c.organization_id
               WHERE o.slug = 'ci-bistro-cairo' ORDER BY c.sort_order LIMIT 1),
             date_trunc('month', now())::date, 6);"

expect_reject "scoring yourself"     "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.employee_criterion_scores
         (organization_id, employee_id, rated_by, criterion_id, period_month, score)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
             (SELECT c.id FROM public.rating_criteria c
                JOIN public.organizations o ON o.id = c.organization_id
               WHERE o.slug = 'ci-bistro-cairo' ORDER BY c.sort_order LIMIT 1),
             date_trunc('month', now())::date, 5);"

expect_reject "back-dating a criterion score into a closed month"     "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.employee_criterion_scores
         (organization_id, employee_id, criterion_id, period_month, score)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
             (SELECT c.id FROM public.rating_criteria c
                JOIN public.organizations o ON o.id = c.organization_id
               WHERE o.slug = 'ci-bistro-cairo' ORDER BY c.sort_order LIMIT 1),
             (date_trunc('month', now()) - interval '1 month')::date, 4);"

exit "$fail"
