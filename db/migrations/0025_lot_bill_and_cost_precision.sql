-- ============================================================================
-- Migration 0025: Record what the delivery cost, and stop rounding rates to
--                 piastres
-- Mosaiz Mundo ERP
--
-- The receiving form now lets someone enter the invoice total instead of a
-- per-unit price, because a total is what a supplier actually hands you. That
-- choice was cosmetic: the total was divided by the quantity in the browser and
-- then thrown away. Two things follow, and the second is a money bug.
--
-- 1. THE INVOICE FIGURE WAS NOT RECORDED. Nothing could later answer "what did
--    this delivery cost?", so a lot could never be reconciled against the bill
--    it came from — which is the only reason to type a total in the first place.
--
-- 2. THE RATE COULD NOT HOLD THE ANSWER. cost_at_purchase is numeric(10,2). For
--    ingredients priced per gram — which is most of them here — the per-unit
--    cost is a fraction of a piastre, and two decimal places destroy it:
--
--       250.00 over 8000 g  = 0.03125/g -> stored 0.03 -> reported  240.00
--                                                          (short by 10.00, 4%)
--        26.00 over  800 g  = 0.0325/g  -> stored 0.03 -> reported   24.00
--                                                          (short by  2.00, 7.7%)
--
--    That is not a display problem. The stored rate is what FIFO multiplies to
--    produce cost of goods sold, so understated rates have been flowing into
--    margin, waste cost and stock value all along, for every ingredient whose
--    unit is smaller than the currency's smallest meaningful slice.
--
-- WHICH COLUMNS. Only the three that hold a RATE (currency per unit of measure):
-- inventory_batches.cost_at_purchase and the two copies taken from it,
-- inventory_consumption.unit_cost and stock_write_off_lines.unit_cost. The
-- others named "price" — sellable_items.price, order_items.unit_price,
-- purchase_order_lines.unit_price — are genuine currency amounts for one
-- sellable or purchasable unit, where two decimal places is exactly right and
-- more would invite prices nobody can pay.
--
-- Widening scale is lossless: 0.03 becomes 0.030000 and every existing figure
-- keeps its value. It does NOT retroactively correct lots that were already
-- rounded — that information is gone, and inventing it would be worse than
-- leaving it visible. Correcting those is what app.correct_batch_cost (0024) is
-- for, and the entered bill now makes the right figure obvious.
--
-- total_cost IS A RECORD, NOT A VALUATION INPUT. Stock value stays
-- quantity_remaining * cost_at_purchase, because value has to fall as stock is
-- consumed and a total cannot do that. The total answers a different question —
-- "does this lot match the supplier's invoice?" — and the two are allowed to
-- differ by the rounding of the rate, which is precisely the discrepancy anyone
-- reconciling would want to see rather than have hidden.
--
-- Depends on: 0005 (batches), 0017 (consumption), 0023 (write-off lines)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Rates get room for a real per-gram price.
--
--    6 decimal places covers a currency-per-gram rate for anything a kitchen
--    buys: at 6dp the smallest representable rate is 0.000001/g, i.e. one
--    piastre per kilogram, which is far below any real ingredient.
-- ----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
    ALTER COLUMN cost_at_purchase TYPE numeric(14, 6);

ALTER TABLE public.inventory_consumption
    ALTER COLUMN unit_cost TYPE numeric(14, 6);

ALTER TABLE public.stock_write_off_lines
    ALTER COLUMN unit_cost TYPE numeric(14, 6);

COMMENT ON COLUMN public.inventory_batches.cost_at_purchase IS
    'Cost of ONE unit_of_measure of this lot — a rate, not a currency amount. numeric(14,6) because a per-gram price is a fraction of a piastre and two decimals silently understated it (0025). FIFO multiplies this by the quantity drawn to produce cost of goods sold.';

-- ----------------------------------------------------------------------------
-- 2. What the delivery actually cost.
--
--    Nullable: lots received before this migration have no recorded invoice,
--    and a stocktake or a void can create stock that never had one. NULL means
--    "not known", which is honest; zero would mean "it was free".
-- ----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
    ADD COLUMN total_cost numeric(12, 2) CHECK (total_cost IS NULL OR total_cost >= 0);

COMMENT ON COLUMN public.inventory_batches.total_cost IS
    'What this delivery cost in total, as stated on the supplier''s invoice (0025). A record for reconciliation, NOT an input to stock value — value must fall as stock is consumed, so it stays quantity_remaining * cost_at_purchase. May differ from quantity_received * cost_at_purchase by the rounding of the rate; that difference is the thing a reconciliation is looking for. NULL when no invoice figure is known.';

COMMIT;
