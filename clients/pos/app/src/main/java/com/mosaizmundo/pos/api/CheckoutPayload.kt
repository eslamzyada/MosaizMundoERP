package com.mosaizmundo.pos.api

// Snake_case property names on purpose: Gson serializes them verbatim, which is
// exactly what app.process_pos_checkout(jsonb) expects.

data class CheckoutItemPayload(
    val sellable_item_id: String,
    val quantity: Int,
    val unit_price: Double,
)

/**
 * The checkout body. The backend's process_pos_checkout requires
 * organization_id, client_offline_id and total_amount in addition to the items,
 * so all four are sent here to match the contract.
 */
data class CheckoutPayload(
    val organization_id: String,
    val client_offline_id: String,
    val total_amount: Double,
    val items: List<CheckoutItemPayload>,
)
