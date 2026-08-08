package com.mosaizmundo.pos.domain

/**
 * The drawer, while it is open (migration 0047).
 *
 * [expectedSoFar] is the server's number, not a sum done here. The point of a
 * cash-up is to compare a physical count against ONE authoritative figure, and
 * a till that computed its own would give a cashier two numbers to choose
 * between at exactly the moment that must not happen.
 */
data class TillSession(
    val id: String,
    val openedAt: String,
    val openingFloat: Double,
    val cashTaken: Double,
    /** Card and the rest. Real money, and not in the drawer. */
    val otherTaken: Double,
    val expectedSoFar: Double,
)

/**
 * What came out of counting it.
 *
 * [variance] is counted − expected: NEGATIVE is short, positive is over. Over
 * is not "fine" — it usually means a sale went unrecorded — so the screen says
 * which it is rather than colouring one green.
 */
data class TillCount(
    val countedCash: Double,
    val expectedCash: Double,
    val variance: Double,
) {
    val isShort: Boolean get() = variance < 0
    val balances: Boolean get() = variance == 0.0
}
