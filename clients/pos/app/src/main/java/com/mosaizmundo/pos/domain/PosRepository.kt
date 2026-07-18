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

    /**
     * Live count of queued offline orders the server PERMANENTLY rejected. These
     * are held (not discarded) so the cashier can be alerted a sale needs
     * attention rather than losing it silently.
     */
    fun failedOrderCount(): Flow<Int>
}
