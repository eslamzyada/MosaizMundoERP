package com.mosaizmundo.pos.domain

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

/** Mock-first: hardcoded, realistic Arabic menu. No network calls. */
class MockPosRepository : PosRepository {
    override suspend fun getMenu(): List<SellableItem> {
        delay(300) // simulate network latency
        return listOf(
            // Availability spans every state on purpose, so the menu's warning
            // and out-of-stock styling are exercised without a backend.
            SellableItem("s1", "شاورما دجاج", 45.0, "🌯", portionsAvailable = 12),
            SellableItem("s2", "برجر لحم", 65.0, "🍔", portionsAvailable = 3),
            SellableItem("s3", "فلافل", 25.0, "🧆", portionsAvailable = 0),
            SellableItem("s4", "بطاطس مقلية", 20.0, "🍟", portionsAvailable = 1),
            SellableItem("s5", "عصير برتقال طازج", 30.0, "🧃", portionsAvailable = 40),
            // No recipe, so nothing tracked constrains it.
            SellableItem("s6", "كولا", 15.0, "🥤", portionsAvailable = null),
        )
    }

    override suspend fun submitOrder(orderState: OrderState) {
        delay(300) // pretend to submit; a no-op for the mock
    }

    override fun failedOrderCount(): Flow<Int> = flowOf(0)
}
