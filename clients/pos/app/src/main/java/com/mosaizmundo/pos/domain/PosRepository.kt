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
     * [managerToken] is null when the signed-in user may void themselves;
     * otherwise it authorises this single call and is never persisted.
     */
    suspend fun voidOrder(orderId: String, restoreStock: Boolean, managerToken: String?)

    /**
     * Live count of queued offline orders the server PERMANENTLY rejected. These
     * are held (not discarded) so the cashier can be alerted a sale needs
     * attention rather than losing it silently.
     */
    fun failedOrderCount(): Flow<Int>
}
