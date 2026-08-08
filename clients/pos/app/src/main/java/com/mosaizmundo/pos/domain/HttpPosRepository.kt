package com.mosaizmundo.pos.domain

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.gson.Gson
import kotlinx.coroutines.flow.Flow
import com.mosaizmundo.pos.api.AddItemsPayload
import com.mosaizmundo.pos.api.CheckoutItemPayload
import com.mosaizmundo.pos.api.CheckoutPayload
import com.mosaizmundo.pos.api.OpenOrderItemPayload
import com.mosaizmundo.pos.api.SettlePayload
import com.mosaizmundo.pos.api.PaymentPayload
import com.mosaizmundo.pos.api.OpenTillPayload
import com.mosaizmundo.pos.api.CloseTillPayload
import com.mosaizmundo.pos.api.OpenOrderPayload
import com.mosaizmundo.pos.api.PosApiProvider
import com.mosaizmundo.pos.api.PosApiService
import com.mosaizmundo.pos.api.VoidOrderPayload
import com.mosaizmundo.pos.data.local.OfflineOrderDao
import com.mosaizmundo.pos.data.local.OfflineOrderEntity
import com.mosaizmundo.pos.data.local.TokenManager
import com.mosaizmundo.pos.workers.SyncOrdersWorker
import kotlinx.coroutines.flow.first
import retrofit2.HttpException
import java.io.IOException
import java.util.UUID

/**
 * Live implementation of PosRepository (Retrofit + Gson) with an offline-first
 * checkout: if the network is down, the order is persisted to Room and a
 * WorkManager sync is scheduled, and the checkout still "succeeds" for the
 * cashier. Every checkout uses a fresh client_offline_id, so the idempotent
 * backend never double-books on retry.
 */
class HttpPosRepository(
    private val dao: OfflineOrderDao,
    private val context: Context,
) : PosRepository {

    private val api: PosApiService = PosApiProvider.create(context)
    private val sessionManager = TokenManager(context)
    private val gson = Gson()

    override fun failedOrderCount(): Flow<Int> = dao.failedCount()

    override suspend fun getMenu(): List<SellableItem> =
        api.getMenu().map { item ->
            SellableItem(
                id = item.id,
                nameAr = item.name,
                price = item.price,
                imagePlaceholder = "🍽️",
                portionsAvailable = item.portions_available,
            )
        }

    override suspend fun recentOrders(): List<PosOrder> =
        api.getOrders().map { order ->
            PosOrder(
                id = order.id,
                status = order.status,
                totalAmount = order.total_amount,
                createdAt = order.created_at,
                // Name x quantity, because a total does not identify an order.
                lineSummary = order.order_items.joinToString(" · ") { line ->
                    "${line.sellable_items?.name ?: "صنف"} x${line.quantity}"
                },
                stockRestored = order.stock_restored,
                voidReason = order.void_reason,
            )
        }

    override suspend fun voidOrder(
        orderId: String,
        restoreStock: Boolean,
        reason: VoidReason,
        note: String,
        managerToken: String?,
    ) {
        // A manager's token rides on this ONE request. It is never written to
        // TokenManager, so the cashier's shift session is untouched and the
        // manager's rights do not outlive the action they authorised. Null means
        // the signed-in user may void themselves, and the interceptor supplies
        // the stored session as usual.
        val response = api.voidOrder(
            orderId = orderId,
            authorization = managerToken?.let { "Bearer $it" },
            payload = VoidOrderPayload(
                restore_stock = restoreStock,
                void_reason = reason.code,
                void_note = note.trim().ifBlank { null },
            ),
        )
        if (!response.isSuccessful) {
            throw HttpException(response)
        }
    }

    // ---- Open tabs (0029) ---------------------------------------------------

    override suspend fun openTabs(): List<OpenTab> =
        api.getOpenTabs().map { order ->
            OpenTab(
                id = order.id,
                note = order.note,
                table = order.restaurant_tables?.let {
                    FloorTable(id = it.id, label = it.label, area = it.area, seats = null)
                },
                totalAmount = order.total_amount,
                openedAt = order.created_at,
                lines = order.order_items.map { line ->
                    OpenTabLine(
                        id = line.id,
                        name = line.sellable_items?.name ?: "صنف",
                        quantity = line.quantity,
                        unitPrice = line.unit_price,
                        note = line.note,
                        firedAt = line.fired_at,
                    )
                },
            )
        }

    override suspend fun tables(): List<FloorTable> =
        // A restaurant without the reservations module answers 409 here, and
        // that is not an error worth showing anybody — it means this till has
        // no tables. Any other failure is treated the same way for the same
        // reason: the picker is a convenience, and losing it must never stop
        // somebody opening a tab.
        runCatching { api.getTables() }
            .getOrDefault(emptyList())
            .filter { it.is_active }
            .map { FloorTable(id = it.id, label = it.label, area = it.area, seats = it.seats) }

    override suspend fun till(): TillSession? =
        api.getTill().session?.let {
            TillSession(
                id = it.id,
                openedAt = it.opened_at,
                openingFloat = it.opening_float,
                cashTaken = it.cash_taken,
                otherTaken = it.other_taken,
                expectedSoFar = it.expected_so_far,
            )
        }

    override suspend fun openTill(openingFloat: Double): TillSession? {
        api.openTill(OpenTillPayload(opening_float = openingFloat)).bodyOrRefusal()
        // Read back rather than assumed: the drawer the screen shows should be
        // the one the server has, including the moment somebody else opened it.
        return till()
    }

    override suspend fun closeTill(countedCash: Double): TillCount {
        val r = api.closeTill(CloseTillPayload(counted_cash = countedCash)).bodyOrRefusal()
            ?: throw TabRefusedException(500, "تعذّر إغلاق الدرج")
        return TillCount(
            countedCash = r.counted_cash,
            expectedCash = r.expected_cash,
            variance = r.variance,
        )
    }

    override suspend fun openTab(note: String, items: List<CartItem>, tableId: String?): String {
        val organizationId = sessionManager.getOrganizationId().first() ?: FALLBACK_ORGANIZATION_ID

        val response = api.openTab(
            OpenOrderPayload(
                organization_id = organizationId,
                // A fresh key per tab. Opening is idempotent on it, so a retry
                // of a request whose answer was lost reopens nothing.
                client_offline_id = UUID.randomUUID().toString(),
                note = note.trim().ifBlank { null },
                items = items.map(::toItemPayload).ifEmpty { null },
                table_id = tableId,
            ),
        )
        val body = response.bodyOrRefusal()
        return body?.order_id
            // A 2xx with no id is not something the till can carry on from: it
            // would leave a tab open on the server that this device cannot name.
            ?: throw TabRefusedException(response.code(), "تعذّر فتح الطاولة")
    }

    override suspend fun addTabItems(orderId: String, items: List<CartItem>) {
        api.addTabItems(orderId, AddItemsPayload(items.map(::toItemPayload))).bodyOrRefusal()
    }

    override suspend fun removeTabLine(lineId: String) {
        api.removeTabItem(lineId).bodyOrRefusal()
    }

    override suspend fun fireTab(orderId: String): Int =
        api.fireTab(orderId).bodyOrRefusal()?.fired ?: 0

    override suspend fun settleTab(orderId: String, tenders: List<Tender>): Double =
        api.settleTab(
            orderId,
            // Empty means unspecified, and must reach the server as an absent
            // field rather than as an empty array — the two are the same to
            // app.record_payments, but only one of them says what it means.
            SettlePayload(
                payments = tenders
                    .takeIf { it.isNotEmpty() }
                    ?.map { PaymentPayload(method = it.method.wire, amount = it.amount) },
            ),
        ).bodyOrRefusal()?.total_amount ?: 0.0

    override suspend fun printers(): List<ConfiguredPrinter> =
        api.getPrinters()
            .filter { it.is_active }
            .mapNotNull { p ->
                // An unrecognised role is skipped, not fatal: a newer backend
                // may know roles this build does not.
                PrinterRole.from(p.role)?.let {
                    ConfiguredPrinter(p.id, p.name, it, p.host, p.port)
                }
            }

    // Blank is not a note: sending "" would reach a CHECK that rejects it, so an
    // empty field becomes an absent one here rather than a refusal at the till.
    private fun toItemPayload(line: CartItem) = OpenOrderItemPayload(
        sellable_item_id = line.sellableItem.id,
        quantity = line.quantity,
        note = line.note?.trim()?.ifBlank { null },
    )

    override suspend fun submitOrder(orderState: OrderState) {
        // The real organization resolved at login (GET /api/me). Falls back to
        // the placeholder only if the session somehow has no org yet.
        val organizationId = sessionManager.getOrganizationId().first() ?: FALLBACK_ORGANIZATION_ID

        val payload = CheckoutPayload(
            organization_id = organizationId,
            client_offline_id = UUID.randomUUID().toString(),
            total_amount = orderState.totalAmount,
            items = orderState.items.map { line ->
                CheckoutItemPayload(
                    sellable_item_id = line.sellableItem.id,
                    quantity = line.quantity,
                    unit_price = line.sellableItem.price,
                    // Blank is not a note. Sending "" would reach a CHECK that
                    // rejects it, so an empty field becomes an absent one here.
                    note = line.note?.trim()?.ifBlank { null },
                )
            },
            note = orderState.note?.trim()?.ifBlank { null },
        )

        val response = try {
            api.checkout(payload)
        } catch (e: IOException) {
            // Network failure: queue the order locally and schedule a sync. Do
            // NOT rethrow — from the cashier's view, the sale is done.
            queueOffline(payload)
            return
        }

        if (!response.isSuccessful) {
            // The server was reachable but rejected the request — a real error
            // that should surface (the ViewModel will not clear the cart).
            throw HttpException(response)
        }
    }

    private suspend fun queueOffline(payload: CheckoutPayload) {
        dao.insertOrder(
            OfflineOrderEntity(
                clientOfflineId = payload.client_offline_id,
                payloadJson = gson.toJson(payload),
            ),
        )
        val request = OneTimeWorkRequestBuilder<SyncOrdersWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .build()
        // Unique work: a single named sync chain drains the WHOLE pending queue,
        // so a burst of offline checkouts can't spawn a swarm of workers all
        // re-POSTing the same orders (analysis F-10). APPEND_OR_REPLACE still
        // guarantees a freshly-queued order triggers a drain.
        WorkManager.getInstance(context).enqueueUniqueWork(
            SYNC_WORK_NAME,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request,
        )
    }

    companion object {
        private const val SYNC_WORK_NAME = "offline-order-sync"

        // Only used if the session has no resolved org (should not happen after
        // a successful login, which stores it via GET /api/me).
        private const val FALLBACK_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000"
    }
}
