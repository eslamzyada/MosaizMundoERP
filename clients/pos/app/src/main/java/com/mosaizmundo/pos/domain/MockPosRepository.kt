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

    // A completed order to void and an already-voided one, so the screen's two
    // states are exercised without a backend.
    private val orders = mutableListOf(
        PosOrder("m-0001", "completed", 155.0, "2026-07-23T12:40:00Z", "شاورما دجاج x2 · كولا x1", null),
        PosOrder("m-0002", "completed", 65.0, "2026-07-23T12:12:00Z", "برجر لحم x1", null),
        // A voided order always has a cause — the database makes the reasonless
        // void this mock used to show an unrepresentable state (0022).
        PosOrder(
            "m-0003", "voided", 25.0, "2026-07-23T11:55:00Z", "فلافل x1", true,
            voidReason = VoidReason.WRONG_ITEM.code,
        ),
    )

    override suspend fun recentOrders(): List<PosOrder> = orders.toList()

    override suspend fun voidOrder(
        orderId: String,
        restoreStock: Boolean,
        reason: VoidReason,
        note: String,
        managerToken: String?,
    ) {
        val index = orders.indexOfFirst { it.id == orderId }
        if (index >= 0) {
            orders[index] = orders[index].copy(
                status = "voided",
                stockRestored = restoreStock,
                voidReason = reason.code,
            )
        }
    }
}
