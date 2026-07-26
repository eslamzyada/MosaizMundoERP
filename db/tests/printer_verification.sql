-- ============================================================================
-- Printer verification (0031) — where a ticket prints, and who may say so.
--
-- The assertion that matters most is the ONE ACTIVE PRINTER PER ROLE rule. Its
-- failure mode is silent: with two active kitchen printers a till picks
-- whichever it read first, and tickets go to a machine nobody is watching. That
-- looks exactly like working software until a table asks where its food is.
--
-- Everything else here is the ordinary shape — tenant isolation, admin-only
-- writes, a member's read — asserted because a printer address is the kind of
-- row that looks harmless and is not: it decides where a restaurant's orders
-- are physically disclosed.
--
-- Run order: after open_order_verification.sql (uses the same COGS fixture
-- identities: cashier, branch_manager, accountant).
-- ============================================================================
\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. A manager configures the two printers.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_port int;
    v_role text;
BEGIN
    INSERT INTO public.printers (id, organization_id, name, role, host)
    VALUES ('9111e400-0000-4000-8000-000000000001',
            'c0570000-0000-4000-8000-000000000000', 'مطبخ', 'kitchen', '192.168.1.50');

    INSERT INTO public.printers (id, organization_id, name, role, host, port)
    VALUES ('9111e400-0000-4000-8000-000000000002',
            'c0570000-0000-4000-8000-000000000000', 'الكاشير', 'receipt', '192.168.1.51', 9101);

    -- 9100 is what a network thermal printer listens on, so it must not need
    -- to be looked up and typed in for the ordinary case.
    SELECT port, role INTO v_port, v_role FROM public.printers
    WHERE id = '9111e400-0000-4000-8000-000000000001';
    IF v_port <> 9100 THEN
        RAISE EXCEPTION 'the raw-printing port must default to 9100, got %', v_port;
    END IF;
    IF v_role <> 'kitchen' THEN
        RAISE EXCEPTION 'expected the kitchen printer, got %', v_role;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. THE ASSERTION THIS TABLE EXISTS FOR: a second ACTIVE printer for the same
--    role is impossible, not merely discouraged.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_count  int;
BEGIN
    BEGIN
        INSERT INTO public.printers (organization_id, name, role, host)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'مطبخ ثانٍ', 'kitchen', '192.168.1.52');
    EXCEPTION WHEN unique_violation THEN
        rejected := true;
    END;

    IF NOT rejected THEN
        RAISE EXCEPTION
            'TWO ACTIVE KITCHEN PRINTERS: "which printer does this ticket go '
            'to?" now has two answers, and a till will pick one arbitrarily — '
            'tickets vanish to a machine nobody is watching';
    END IF;

    SELECT count(*) INTO v_count FROM public.printers
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
      AND role = 'kitchen' AND is_active;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'exactly one active kitchen printer expected, got %', v_count;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Swapping a printer works: deactivate the old, add the new. The index is
--    PARTIAL, so retired rows pile up harmlessly and their history survives.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_active int;
    v_total  int;
    v_host   text;
BEGIN
    UPDATE public.printers SET is_active = false
    WHERE id = '9111e400-0000-4000-8000-000000000001';

    INSERT INTO public.printers (id, organization_id, name, role, host)
    VALUES ('9111e400-0000-4000-8000-000000000003',
            'c0570000-0000-4000-8000-000000000000', 'مطبخ جديد', 'kitchen', '192.168.1.60');

    SELECT count(*) FILTER (WHERE is_active), count(*) INTO v_active, v_total
    FROM public.printers
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000' AND role = 'kitchen';

    IF v_active <> 1 OR v_total <> 2 THEN
        RAISE EXCEPTION
            'after a swap there must be 1 active kitchen printer and 2 rows, got % / %',
            v_active, v_total;
    END IF;

    SELECT host INTO v_host FROM public.printers
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
      AND role = 'kitchen' AND is_active;
    IF v_host <> '192.168.1.60' THEN
        RAISE EXCEPTION 'the active kitchen printer must be the new one, got %', v_host;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. updated_at moves on its own, per the house convention.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before timestamptz;
    v_after  timestamptz;
BEGIN
    SELECT updated_at INTO v_before FROM public.printers
    WHERE id = '9111e400-0000-4000-8000-000000000003';

    PERFORM pg_sleep(0.01);
    UPDATE public.printers SET host = '192.168.1.61'
    WHERE id = '9111e400-0000-4000-8000-000000000003';

    SELECT updated_at INTO v_after FROM public.printers
    WHERE id = '9111e400-0000-4000-8000-000000000003';

    IF v_after <= v_before THEN
        RAISE EXCEPTION 'the updated_at trigger did not fire (% -> %)', v_before, v_after;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Nonsense is refused by the database, not just by a form.
--
--    Every insert here is is_active = false, and that is load-bearing. The
--    partial unique index does not cover inactive rows, so the ONLY thing that
--    can refuse these is the CHECK each one is named for. Left active, they
--    would collide with the existing printer first and come back 23505 — a
--    refusal that looks like a pass while proving nothing about the CHECK.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    caught text;
BEGIN
    -- A role the software has no meaning for.
    caught := NULL;
    BEGIN
        INSERT INTO public.printers (organization_id, name, role, host, is_active)
        VALUES ('c0570000-0000-4000-8000-000000000000', 'ملصقات', 'label', '192.168.1.70', false);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '23514' THEN
        RAISE EXCEPTION 'an unknown printer role must be refused, got %',
            COALESCE(caught, 'nothing');
    END IF;

    -- A port outside the range one can exist on.
    caught := NULL;
    BEGIN
        INSERT INTO public.printers (organization_id, name, role, host, port, is_active)
        VALUES ('c0570000-0000-4000-8000-000000000000', 'خطأ', 'receipt', '192.168.1.71', 70000, false);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '23514' THEN
        RAISE EXCEPTION 'an impossible port must be refused, got %', COALESCE(caught, 'nothing');
    END IF;

    -- A blank address, which would be a printer nobody can reach and nobody
    -- can see is misconfigured.
    caught := NULL;
    BEGIN
        INSERT INTO public.printers (organization_id, name, role, host, is_active)
        VALUES ('c0570000-0000-4000-8000-000000000000', 'فارغ', 'receipt', '   ', false);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '23514' THEN
        RAISE EXCEPTION 'a blank host must be refused, got %', COALESCE(caught, 'nothing');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A CASHIER may READ the address — they cannot print without it — but may
--    not change where the kitchen's tickets go, nor delete the row.
--
--    The DELETE case is the one worth stating plainly: user_belongs_to_org is
--    FOR ALL and PERMISSIVE, so the DELETE grant would be enough on its own
--    without require_admin_delete. That exact gap has appeared three times
--    before (0014, 0019, 0024).
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_visible int;
    v_rows    int;
    caught    text;
BEGIN
    SELECT count(*) INTO v_visible FROM public.printers
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
    IF v_visible < 2 THEN
        RAISE EXCEPTION
            'a cashier cannot see the printers (%): they could not print at all',
            v_visible;
    END IF;

    -- RLS filters rather than raising, so a refused write updates NO ROW.
    UPDATE public.printers SET host = '10.0.0.1'
    WHERE id = '9111e400-0000-4000-8000-000000000003';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION
            'a cashier redirected the kitchen printer; where a restaurant''s '
            'orders print is an administrative decision';
    END IF;

    DELETE FROM public.printers WHERE id = '9111e400-0000-4000-8000-000000000003';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION
            'a cashier DELETED a printer: the permissive FOR ALL policy covers '
            'DELETE, so the grant needs its own RESTRICTIVE gate';
    END IF;

    -- Inactive for the same reason as section 5: an active row would hit the
    -- unique index first, and this assertion is about the policy, not the index.
    caught := NULL;
    BEGIN
        INSERT INTO public.printers (organization_id, name, role, host, is_active)
        VALUES ('c0570000-0000-4000-8000-000000000000', 'مهرب', 'receipt', '10.0.0.2', false);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION
            'a cashier added a printer (got %): anyone who can add one can '
            'point a copy of every order at a machine of their choosing',
            COALESCE(caught, 'no error at all');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Another organization's printers are invisible.
--
--    Not a formality: this row says where a restaurant's orders are physically
--    printed. Leaking it across tenants would tell one restaurant how to print
--    onto another's machine.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_seen int;
    v_rows int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.printers
    WHERE organization_id <> 'c0570000-0000-4000-8000-000000000000';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION
            'CROSS-TENANT LEAK: % printer(s) from another organization are '
            'visible, disclosing where their orders print', v_seen;
    END IF;

    -- And an id that is known cannot be written to either.
    UPDATE public.printers SET host = '10.0.0.3'
    WHERE id = '9111e400-000f-400f-800f-00000000000f';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'wrote to another organization''s printer';
    END IF;
END;
$$;

SELECT 'printer_verification: all assertions passed' AS result;
