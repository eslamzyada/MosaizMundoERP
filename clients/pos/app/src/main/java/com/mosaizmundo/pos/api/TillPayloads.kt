package com.mosaizmundo.pos.api

/**
 * The drawer (migration 0047), as the API sends and takes it.
 *
 * Every number here is the server's. Nothing on the till recomputes what
 * should be in the drawer, because a second implementation of the one figure
 * a cashier is held to could only ever disagree with the first.
 */

/** GET /api/till. [session] is null when no drawer is open — a fact, not a failure. */
data class TillResponse(
    val session: TillSessionResponse?,
)

data class TillSessionResponse(
    val id: String,
    val opened_at: String,
    val opening_float: Double,
    val cash_taken: Double,
    /** Card and everything else: real revenue, and not in the drawer. */
    val other_taken: Double,
    /** Float plus cash so far. Still moving — the frozen one comes at close. */
    val expected_so_far: Double,
)

data class OpenTillPayload(
    val opening_float: Double,
    val note: String? = null,
)

/**
 * POST /api/till/close.
 *
 * [counted_cash] has no default anywhere in this stack. A close that assumed
 * the drawer held exactly what it should would report a variance of zero every
 * night, which is the one answer a cash-up must never invent.
 */
data class CloseTillPayload(
    val counted_cash: Double,
    val note: String? = null,
)

data class CloseTillResult(
    val session_id: String,
    val closed_at: String,
    val counted_cash: Double,
    val expected_cash: Double,
    val variance: Double,
)
