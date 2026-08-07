package com.mosaizmundo.pos.api

/**
 * A table on the floor plan (migration 0039), as the API sends it.
 *
 * The floor plan belongs to the `reservations` module, so a restaurant that
 * does not run it has none — `GET /api/reservations/tables` answers 409 there,
 * and the till falls back to what it always did: a tab described by a note.
 * That is not a degraded mode, it is the correct one for takeaway counters.
 */
data class RestaurantTableResponse(
    val id: String,
    val label: String,
    val area: String?,
    val seats: Int?,
    val is_active: Boolean,
)

/** The table a tab is running at, as it arrives nested on an order. */
data class OrderTableResponse(
    val id: String,
    val label: String,
    val area: String?,
)
