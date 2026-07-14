package com.mosaizmundo.pos.domain

/**
 * Data-access boundary for the POS. The UI/ViewModel depend only on this
 * interface, so MockPosRepository and HttpPosRepository are interchangeable.
 */
interface PosRepository {
    suspend fun getMenu(): List<SellableItem>

    /** Submits the current order to the backend (idempotent per client_offline_id). */
    suspend fun submitOrder(orderState: OrderState)
}
