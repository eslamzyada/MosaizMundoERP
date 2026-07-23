package com.mosaizmundo.pos.api

/**
 * One row of GET /api/pos/menu.
 *
 * [portionsAvailable] is how many portions the stock on hand can still make —
 * the smallest number any one ingredient allows. NULL means unconstrained: the
 * item has no recipe, so no tracked ingredient limits it (a bottled drink, say).
 * That is deliberately different from 0, which means an ingredient has run out.
 *
 * It is ADVISORY. The device may be offline with a stale figure, and the server
 * records a deficit when a sale outruns stock, so this never blocks a sale.
 */
data class MenuItemResponse(
    val id: String,
    val name: String,
    val price: Double,
    val portions_available: Int?,
)
