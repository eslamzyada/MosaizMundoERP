package com.mosaizmundo.pos.domain

/**
 * A tab a table is still running (migration 0029).
 *
 * The distinction that drives this whole screen is [OpenTabLine.isFired]:
 *
 *   NOT fired  the kitchen has not been told. Nothing has been cooked, no
 *              ingredient has moved, and a server may still take the line off.
 *
 *   FIRED      the food exists. Its ingredients are gone and somebody made it,
 *              so removing it is not a delete — it is a void, which asks
 *              whether the food was made and what to do about the stock.
 *
 * Both states are shown, never filtered, because "what has the kitchen already
 * got?" is the question a server is actually asking when they look at a table.
 */
data class OpenTab(
    val id: String,
    /** Table number, takeaway, an allergy warning — context for the whole tab. */
    val note: String?,
    val totalAmount: Double,
    val openedAt: String,
    val lines: List<OpenTabLine>,
) {
    /** Lines the kitchen has not been told about yet. */
    val unfiredCount: Int get() = lines.count { !it.isFired }

    /** True when there is something to send. Settling is refused until there is not. */
    val hasUnfired: Boolean get() = unfiredCount > 0
}

data class OpenTabLine(
    val id: String,
    val name: String,
    val quantity: Int,
    val unitPrice: Double,
    /** "no onions", "well done" — prints beside this item on the ticket. */
    val note: String?,
    /**
     * Null until the line goes to the kitchen. Kept as the server's own string
     * rather than parsed: the till only ever asks whether it is null, and a
     * timestamp parse is a way to crash a screen over something it never reads.
     */
    val firedAt: String?,
) {
    val isFired: Boolean get() = firedAt != null
    val lineTotal: Double get() = unitPrice * quantity
}
