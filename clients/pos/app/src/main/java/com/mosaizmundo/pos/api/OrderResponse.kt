package com.mosaizmundo.pos.api

/**
 * One row of GET /api/pos/orders.
 *
 * [stock_restored] is null until the order is voided, then records the answer
 * given to "was the food made?" — true means the ingredients went back.
 */
data class OrderResponse(
    val id: String,
    /** 'open' while a table is still eating, then 'completed' or 'voided' (0029). */
    val status: String,
    /** Context for the whole order: table number, takeaway, an allergy (0028). */
    val note: String?,
    val total_amount: Double,
    val created_at: String,
    val stock_restored: Boolean?,
    /** Why it was voided (0022). Null exactly when the order is not voided. */
    val void_reason: String?,
    val order_items: List<OrderLineResponse>,
)

data class OrderLineResponse(
    /** Needed to delete this specific line off a tab (0029). */
    val id: String,
    val sellable_item_id: String,
    val quantity: Int,
    val unit_price: Double,
    /** How this line is wanted — "no onions" (0028). */
    val note: String?,
    /**
     * When this line went to the kitchen (0029). NULL means it has not been
     * sent, which is the ONLY thing that decides whether a server may still
     * take it off the tab: once it is fired the food exists, its ingredients
     * are gone, and removing it is a void rather than a delete.
     */
    val fired_at: String?,
    val sellable_items: OrderLineItem?,
)

/** The item's name, so a cashier can recognise the order they mis-rang. */
data class OrderLineItem(
    val name: String,
    val sku: String?,
)

/**
 * POST /api/pos/orders/{id}/void.
 *
 * [restore_stock] is REQUIRED by the backend and has no default: only the
 * person voiding knows whether the food was actually made, and guessing either
 * way corrupts inventory half the time (migration 0018).
 *
 * [void_reason] is REQUIRED too (0022) and must come from the shared
 * vocabulary. [void_note] is optional context, mandatory only for 'other' —
 * null rather than "" when there is none, so the column stays null and readers
 * do not have to special-case an empty string.
 */
data class VoidOrderPayload(
    val restore_stock: Boolean,
    val void_reason: String,
    val void_note: String?,
)
