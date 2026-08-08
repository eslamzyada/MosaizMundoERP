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

    // Two tabs covering the states the screen has to render: one with food
    // already at the kitchen AND a course still unsent (so "send" is offered and
    // "settle" is refused), and one wholly unsent.
    private val tabs = mutableListOf(
        OpenTab(
            id = "t-0001",
            // The note is now context, not identity — the TABLE identifies it.
            note = "حساسية مكسرات",
            table = FloorTable(id = "tbl-1", label = "طاولة ١", area = "الصالة", seats = 4),
            totalAmount = 140.0,
            openedAt = "2026-07-26T18:05:00Z",
            lines = listOf(
                OpenTabLine("l-1", "شاورما دجاج", 2, 45.0, "بدون بصل", "2026-07-26T18:07:00Z"),
                OpenTabLine("l-2", "كولا", 1, 15.0, null, "2026-07-26T18:07:00Z"),
                OpenTabLine("l-3", "بطاطس مقلية", 1, 20.0, null, null),
            ),
        ),
        OpenTab(
            id = "t-0002",
            // Takeaway: no table, and none needed.
            note = "تيك أواي",
            table = null,
            totalAmount = 65.0,
            openedAt = "2026-07-26T18:20:00Z",
            lines = listOf(OpenTabLine("l-4", "برجر لحم", 1, 65.0, "ويل دن", null)),
        ),
    )

    override suspend fun openTabs(): List<OpenTab> {
        delay(200)
        return tabs.toList()
    }

    private val mockTables = listOf(
        FloorTable(id = "tbl-1", label = "طاولة ١", area = "الصالة", seats = 4),
        FloorTable(id = "tbl-2", label = "طاولة ٢", area = "الصالة", seats = 2),
        FloorTable(id = "tbl-3", label = "طاولة ٣", area = "الشرفة", seats = 6),
    )

    override suspend fun tables(): List<FloorTable> {
        delay(100)
        return mockTables
    }

    override suspend fun openTab(note: String, items: List<CartItem>, tableId: String?): String {
        // One table, one tab — the same rule the database enforces, so the demo
        // build behaves like the real one rather than teaching a habit that
        // breaks against a server.
        if (tableId != null && tabs.any { it.table?.id == tableId }) {
            val label = mockTables.firstOrNull { it.id == tableId }?.label ?: "الطاولة"
            throw TabRefusedException(409, "طاولة $label عليها حساب مفتوح بالفعل")
        }

        val id = "t-${(tabs.size + 1).toString().padStart(4, '0')}"
        tabs += OpenTab(
            id = id,
            note = note.trim().ifBlank { null },
            table = tableId?.let { t -> mockTables.firstOrNull { it.id == t } },
            totalAmount = items.sumOf { it.sellableItem.price * it.quantity },
            openedAt = "2026-07-26T18:30:00Z",
            lines = items.map(::mockLine),
        )
        return id
    }

    override suspend fun addTabItems(orderId: String, items: List<CartItem>) {
        replaceTab(orderId) { tab ->
            val lines = tab.lines + items.map(::mockLine)
            tab.copy(lines = lines, totalAmount = lines.sumOf { it.lineTotal })
        }
    }

    override suspend fun removeTabLine(lineId: String) {
        val tab = tabs.firstOrNull { t -> t.lines.any { it.id == lineId } } ?: return
        val line = tab.lines.first { it.id == lineId }
        // The mock enforces this too. A mock that allowed what the server
        // refuses would teach the UI a rule that does not exist.
        if (line.isFired) {
            throw TabRefusedException(409, "هذا الصنف أُرسل للمطبخ ولا يمكن حذفه")
        }
        replaceTab(tab.id) { t ->
            val lines = t.lines.filterNot { it.id == lineId }
            t.copy(lines = lines, totalAmount = lines.sumOf { it.lineTotal })
        }
    }

    override suspend fun fireTab(orderId: String): Int {
        val tab = tabs.first { it.id == orderId }
        if (!tab.hasUnfired) {
            throw TabRefusedException(409, "لا يوجد ما يُرسل للمطبخ")
        }
        val fired = tab.unfiredCount
        replaceTab(orderId) { t ->
            t.copy(lines = t.lines.map { if (it.isFired) it else it.copy(firedAt = "2026-07-26T18:35:00Z") })
        }
        return fired
    }

    /** What the mock has recorded, so a test can read the tender back. */
    val recorded = mutableMapOf<String, List<Tender>>()

    override suspend fun settleTab(orderId: String, tenders: List<Tender>): Double {
        val tab = tabs.first { it.id == orderId }
        if (tab.hasUnfired) {
            throw TabRefusedException(
                409,
                "${tab.unfiredCount} صنف لم يُرسل للمطبخ؛ أرسله أو احذفه قبل التحصيل",
            )
        }

        // The same sum rule the server enforces, so the demo build cannot
        // teach a habit that breaks against a real one.
        if (tenders.isNotEmpty()) {
            val paid = Math.round(tenders.sumOf { it.amount } * 100) / 100.0
            val bill = Math.round(tab.totalAmount * 100) / 100.0
            if (paid != bill) {
                throw TabRefusedException(400, "المبلغ المحصّل $paid لا يساوي الحساب $bill")
            }
        }

        recorded[orderId] = tenders
        tabs.removeAll { it.id == orderId }
        return tab.totalAmount
    }

    // A kitchen printer that is configured but not reachable, which is the
    // state the warning path has to handle.
    override suspend fun printers(): List<ConfiguredPrinter> = listOf(
        ConfiguredPrinter("p-1", "المطبخ", PrinterRole.KITCHEN, "192.168.1.50", 9100),
        ConfiguredPrinter("p-2", "الكاشير", PrinterRole.RECEIPT, "192.168.1.51", 9100),
    )

    private fun mockLine(line: CartItem) = OpenTabLine(
        id = "l-${line.lineId.take(8)}",
        name = line.sellableItem.nameAr,
        quantity = line.quantity,
        unitPrice = line.sellableItem.price,
        note = line.note?.trim()?.ifBlank { null },
        firedAt = null,
    )

    private fun replaceTab(orderId: String, transform: (OpenTab) -> OpenTab) {
        val index = tabs.indexOfFirst { it.id == orderId }
        if (index >= 0) tabs[index] = transform(tabs[index])
    }

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
