package com.mosaizmundo.pos.workers

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.gson.Gson
import com.mosaizmundo.pos.api.CheckoutPayload
import com.mosaizmundo.pos.api.PosApiProvider
import com.mosaizmundo.pos.data.local.PosDatabase
import java.io.IOException

/**
 * Drains the locally-queued (PENDING) offline orders to the backend. The backend
 * is idempotent per client_offline_id, so re-POSTing an order that was already
 * processed (but whose response was lost) is a safe no-op that still returns 2xx.
 */
class SyncOrdersWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val dao = PosDatabase.getInstance(applicationContext).offlineOrderDao()
        val api = PosApiProvider.create(applicationContext)
        val gson = Gson()

        val pending = dao.getPendingOrders()
        var retryNeeded = false

        for (order in pending) {
            val payload = gson.fromJson(order.payloadJson, CheckoutPayload::class.java)
            val response = try {
                api.checkout(payload)
            } catch (e: IOException) {
                // Still offline — keep it PENDING and retry later.
                retryNeeded = true
                continue
            }

            when {
                response.isSuccessful -> {
                    // Submitted (the idempotent backend also returns 2xx on a
                    // re-delivered order). Done: remove it so the queue stays
                    // bounded (F-09).
                    dao.deleteOrder(order.clientOfflineId)
                }
                response.code() in 400..499 -> {
                    // Permanently rejected (bad payload, a role changed while
                    // offline, a deleted item). Do NOT discard the sale — mark it
                    // FAILED so it stops retrying yet stays visible (F-03).
                    dao.markOrderFailed(order.clientOfflineId)
                }
                else -> {
                    // 5xx: transient server error, retry later.
                    retryNeeded = true
                }
            }
        }

        return if (retryNeeded) Result.retry() else Result.success()
    }
}
