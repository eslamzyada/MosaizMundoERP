package com.mosaizmundo.pos.domain

import android.content.Context
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.gson.Gson
import com.mosaizmundo.pos.api.CheckoutItemPayload
import com.mosaizmundo.pos.api.CheckoutPayload
import com.mosaizmundo.pos.api.PosApiProvider
import com.mosaizmundo.pos.api.PosApiService
import com.mosaizmundo.pos.data.local.OfflineOrderDao
import com.mosaizmundo.pos.data.local.OfflineOrderEntity
import com.mosaizmundo.pos.workers.SyncOrdersWorker
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
    private val gson = Gson()

    override suspend fun getMenu(): List<SellableItem> =
        api.getRecipes().map { recipe ->
            SellableItem(
                id = recipe.id,
                nameAr = recipe.name,
                price = recipe.price,
                imagePlaceholder = "🍽️",
            )
        }

    override suspend fun submitOrder(orderState: OrderState) {
        val payload = CheckoutPayload(
            organization_id = ORGANIZATION_ID,
            client_offline_id = UUID.randomUUID().toString(),
            total_amount = orderState.totalAmount,
            items = orderState.items.map { line ->
                CheckoutItemPayload(
                    sellable_item_id = line.sellableItem.id,
                    quantity = line.quantity,
                    unit_price = line.sellableItem.price,
                )
            },
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
        WorkManager.getInstance(context).enqueue(request)
    }

    companion object {
        // TODO: source from the authenticated session once POS auth lands. The
        // backend also needs a valid bearer token; that is a later phase.
        private const val ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000"
    }
}
