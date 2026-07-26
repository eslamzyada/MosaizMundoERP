package com.mosaizmundo.pos.domain

import kotlinx.coroutines.flow.Flow

/**
 * Data-access boundary for the POS. The UI/ViewModel depend only on this
 * interface, so MockPosRepository and HttpPosRepository are interchangeable.
 */
interface PosRepository {
    suspend fun getMenu(): List<SellableItem>

    /** Submits the current order to the backend (idempotent per client_offline_id). */
    suspend fun submitOrder(orderState: OrderState)

    /** Recent orders, newest first, so a mistake can be found at the till. */
    suspend fun recentOrders(): List<PosOrder>

    /**
     * Voids an order.
     *
     * [restoreStock] answers "was the food made?" — true returns the
     * ingredients, false leaves them deducted. The backend requires it and has
     * no default (migration 0018), because either guess is wrong half the time.
     *
     * [reason] is why (0022); the database refuses a void without one. [note] is
     * optional context and mandatory only for [VoidReason.OTHER]. The two are
     * independent of [restoreStock] on purpose — a kitchen error caught at the
     * pass restores stock, a cancellation after plating does not.
     *
     * [managerToken] is null when the signed-in user may void themselves;
     * otherwise it authorises this single call and is never persisted.
     */
    suspend fun voidOrder(
        orderId: String,
        restoreStock: Boolean,
        reason: VoidReason,
        note: String,
        managerToken: String?,
    )

    // ---- Open tabs (0029) ---------------------------------------------------
    //
    // These are deliberately ONLINE-ONLY, unlike checkout. A tab is shared state
    // that a kitchen and possibly a second till are both acting on: queueing
    // "fire table 5" on a device with no signal would tell a server the food is
    // on its way when nothing has reached the kitchen. Checkout can be queued
    // because a completed sale is a fact about the past; a tab is a claim about
    // right now.

    /** Every tab currently running, oldest first — longest wait comes first. */
    suspend fun openTabs(): List<OpenTab>

    /** Opens a tab. [items] may be empty: a table is seated before it orders. */
    suspend fun openTab(note: String, items: List<CartItem>): String

    /** Adds a later course. The lines land UNFIRED. */
    suspend fun addTabItems(orderId: String, items: List<CartItem>)

    /** Removes a line. Fails if it has already gone to the kitchen. */
    suspend fun removeTabLine(lineId: String)

    /** Sends everything unfired to the kitchen; returns how many lines went. */
    suspend fun fireTab(orderId: String): Int

    /** Takes the money; returns the settled total. Refused while anything is unfired. */
    suspend fun settleTab(orderId: String): Double

    /** The printers configured for this organization (0031). */
    suspend fun printers(): List<ConfiguredPrinter>

    /**
     * Live count of queued offline orders the server PERMANENTLY rejected. These
     * are held (not discarded) so the cashier can be alerted a sale needs
     * attention rather than losing it silently.
     */
    fun failedOrderCount(): Flow<Int>
}
