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

# ----------------------------------------------------------------------------
# 0036. A notification is delivered outside the query path, so the app role has
# no way to write one: no INSERT, no DELETE, and UPDATE only on read_at. Every
# statement below must be refused on privilege alone — none of them depends on
# a row existing, which is why they belong here rather than in a suite.
# ----------------------------------------------------------------------------
expect_reject "sending a notification to somebody else" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.notifications (organization_id, recipient_id, kind, subject)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             '99999999-9999-4999-8999-999999999999',
             'phish', 'اضغط هنا لتأكيد كلمة المرور');"

expect_reject "writing a notification to YOURSELF (the own-row policy would allow it)" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.notifications (organization_id, recipient_id, kind, subject)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'self', 'ملاحظة لنفسي');"

expect_reject "calling the delivery function directly" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     SELECT app.notify_user(
         (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
         '99999999-9999-4999-8999-999999999999', 'phish', 'رسالة منتحلة');"

expect_reject "broadcasting to a whole role" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     SELECT app.notify_roles(
         (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
         ARRAY['waiter'], 'phish', 'إعلان للجميع');"

expect_reject "rewriting the message you were sent" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     UPDATE public.notifications SET subject = 'شيء آخر تمامًا';"

expect_reject "deleting a notification you were sent" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     DELETE FROM public.notifications;"

# ----------------------------------------------------------------------------
# 0037. Which capabilities a tenant runs is not a thing the tenant's own client
# gets to answer about itself: the catalogue is read-only, the subscription is
# written only by app.set_module, and set_module refuses an organization the
# caller does not belong to.
# ----------------------------------------------------------------------------
expect_reject "adding a module to the catalogue from the application" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.modules (key, name_ar, description_ar)
     VALUES ('rogue', 'وحدة مزروعة', 'وحدة لم تمر بترحيل');"

expect_reject "granting yourself a module by writing the table directly" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.organization_modules (organization_id, module_key, enabled)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'purchasing', true);"

expect_reject "editing your own subscription directly" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     UPDATE public.organization_modules SET enabled = true;"

expect_reject "dropping a module row to fall back to the default" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     DELETE FROM public.organization_modules;"

expect_reject "switching a module in an organization you do not belong to" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     SELECT app.set_module('00000000-0000-4000-8000-000000000000', 'purchasing', false);"

# ----------------------------------------------------------------------------
# 0038. Hours are not writable by the application under any circumstances. The
# clock is three SECURITY DEFINER procedures; the table itself is read-only to
# mosaiz_app_user, which is what makes a time record a record and not a claim.
# ----------------------------------------------------------------------------
expect_reject "inventing an hour you did not work" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
             now() - interval '9 hours', now());"

expect_reject "back-dating the hours you did work" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     UPDATE public.time_entries SET started_at = now() - interval '12 hours';"

expect_reject "deleting an hour somebody would rather forget" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     DELETE FROM public.time_entries;"

# The shift CHECK constraints are NOT asserted here. They would appear to pass:
# this file runs before any fixture enables the labour module, so 0037's gate
# refuses a shift INSERT before the constraints are ever consulted — a rejection
# that would survive deleting the constraints outright. They are asserted in
# labour_verification.sql instead, with the module switched on.
expect_reject "scheduling a shift for a restaurant that does not run labour" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
             now() + interval '1 day', now() + interval '1 day 8 hours');"

# ----------------------------------------------------------------------------
# 0040. The public queue is not writable by the application under any
# circumstances: requests arrive only through app.place_public_order, which
# prices every line from the menu. A controller that could insert one directly
# is a controller that could set its own prices.
# ----------------------------------------------------------------------------
expect_reject "filing a public order directly, at a price of your choosing" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.public_orders
         (organization_id, customer_name, customer_phone, quoted_total)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'مزيّف', '0100000', 0.01);"

expect_reject "adding a line to a public order directly" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.public_order_lines
         (public_order_id, organization_id, sellable_item_id, quantity, unit_price, item_name)
     VALUES (gen_random_uuid(),
             (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             gen_random_uuid(), 1, 0.01, 'مزيّف');"

expect_reject "deleting a request somebody would rather forget" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     DELETE FROM public.public_orders;"

# ----------------------------------------------------------------------------
# 0042. Pay is the most confidential data here. It is not deletable, and the
# rate history is not editable into a different past — a raise is a new row.
# ----------------------------------------------------------------------------
expect_reject "deleting a pay record" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     DELETE FROM public.employee_wages;"

# Labelled for what it actually proves. This identity holds no membership at
# the point this file runs, so the refusal is the ORGANIZATION policy — not the
# module gate, and not the payroll role gate. Those two are asserted in
# wages_verification.sql, where the identities are real members and the
# distinction can be made honestly.
expect_reject "recording pay in an organization you do not belong to" \
    "SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
     INSERT INTO public.employee_wages
         (organization_id, user_id, hourly_rate, effective_from, set_by)
     VALUES ((SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo'),
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 100.00, current_date,
             'cccccccc-cccc-4ccc-8ccc-cccccccccccc');"

exit "$fail"
