package com.mosaizmundo.pos.api

/**
 * Wire types for open tabs (migration 0029).
 *
 * A tab is an order a table is still adding to. It is NOT a sale until it is
 * settled, and no ingredient moves until its lines are fired to the kitchen —
 * both of those facts live in the database, and nothing here is allowed to
 * assume otherwise.
 *
 * No price appears in any request below. The server reads prices from the
 * catalogue (0012); a till that could name a price could discount at will.
 */

/**
 * POST /api/pos/orders/open.
 *
 * [items] is nullable because a table is seated and handed menus before it
 * orders anything, and an empty tab is the honest record of that.
 *
 * [client_offline_id] makes opening idempotent, exactly as it does for
 * checkout: a till that retries a request it never saw the answer to must not
 * end up with two tabs for one table.
 */
data class OpenOrderPayload(
    val organization_id: String,
    val client_offline_id: String,
    val note: String?,
    val items: List<OpenOrderItemPayload>?,
    /**
     * Which table this party is sitting at (migration 0045).
     *
     * Nullable and staying that way: takeaway has no table, and a restaurant
     * without the `reservations` module has no floor plan to choose from. When
     * it IS sent the server refuses a table that is already running a tab —
     * one table, one tab — and names it in the refusal.
     */
    val table_id: String? = null,
)

data class OpenOrderItemPayload(
    val sellable_item_id: String,
    val quantity: Int,
    /** How this one line is wanted — "no onions". Prints beside its own item. */
    val note: String?,
)

/** POST /api/pos/orders/{id}/items — a later course on a running tab. */
data class AddItemsPayload(
    val items: List<OpenOrderItemPayload>,
)

data class OpenOrderResult(
    val order_id: String?,
)

data class AddItemsResult(
    val added: Int,
    val total_amount: Double?,
)

/** How many lines this call actually sent to the kitchen. */
data class FireResult(
    val fired: Int,
)

/**
 * One tender against a bill (migration 0046).
 *
 * [amount] is what this line CONTRIBUTES to the bill, not what was handed
 * over. Cash given for a smaller bill produces change, and the change never
 * entered the business.
 */
data class PaymentPayload(
    val method: String,
    val amount: Double,
    val note: String? = null,
)

/**
 * POST /api/pos/orders/{id}/settle.
 *
 * [payments] is nullable and stays that way. Sending nothing settles the bill
 * as UNSPECIFIED — which is honest — where sending a guessed 'cash' would make
 * the nightly cash-up a fiction. When it IS sent, the amounts must add up to
 * the bill or the server refuses and the tab stays open.
 */
data class SettlePayload(
    val payments: List<PaymentPayload>?,
)

data class SettleResult(
    val total_amount: Double?,
)
