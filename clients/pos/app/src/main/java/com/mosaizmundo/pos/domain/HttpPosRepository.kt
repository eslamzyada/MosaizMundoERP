package com.mosaizmundo.pos.domain

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.gson.Gson
import kotlinx.coroutines.flow.Flow
import com.mosaizmundo.pos.api.CheckoutItemPayload
import com.mosaizmundo.pos.api.CheckoutPayload
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
