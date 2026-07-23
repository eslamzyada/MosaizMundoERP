package com.mosaizmundo.pos.api

/**
 * One row of GET /api/pos/orders.
 *
 * [stock_restored] is null until the order is voided, then records the answer
 * given to "was the food made?" — true means the ingredients went back.
 */
data class OrderResponse(
    val id: String,
    val status: String,
    val total_amount: Double,
    val created_at: String,
    val stock_restored: Boolean?,
    val order_items: List<OrderLineResponse>,
)

data class OrderLineResponse(
    val sellable_item_id: String,
    val quantity: Int,
    val unit_price: Double,
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
 */
data class VoidOrderPayload(
    val restore_stock: Boolean,
)
