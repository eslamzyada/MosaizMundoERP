package com.mosaizmundo.pos.api

// Snake_case property names on purpose: Gson serializes them verbatim, which is
// exactly what app.process_pos_checkout(jsonb) expects.

data class CheckoutItemPayload(
    val sellable_item_id: String,
    val quantity: Int,
    val unit_price: Double,
    /**
     * How this one line is wanted ("بدون بصل"). Null when there is nothing to
     * say — Gson omits a null field entirely, and the procedure treats an
     * absent note exactly like no note, so older payloads keep working (0028).
     */
    val note: String? = null,
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
    /** Context for the whole order: "طاولة ٥", "تيك أواي", an allergy warning. */
    val note: String? = null,
)
