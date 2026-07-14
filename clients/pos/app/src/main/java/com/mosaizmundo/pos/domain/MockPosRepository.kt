package com.mosaizmundo.pos.domain

import kotlinx.coroutines.delay

/** Mock-first: hardcoded, realistic Arabic menu. No network calls. */
class MockPosRepository : PosRepository {
    override suspend fun getMenu(): List<SellableItem> {
        delay(300) // simulate network latency
        return listOf(
            SellableItem("s1", "شاورما دجاج", 45.0, "🌯"),
            SellableItem("s2", "برجر لحم", 65.0, "🍔"),
            SellableItem("s3", "فلافل", 25.0, "🧆"),
            SellableItem("s4", "بطاطس مقلية", 20.0, "🍟"),
            SellableItem("s5", "عصير برتقال طازج", 30.0, "🧃"),
            SellableItem("s6", "كولا", 15.0, "🥤"),
        )
    }

    override suspend fun submitOrder(orderState: OrderState) {
        delay(300) // pretend to submit; a no-op for the mock
    }
}
