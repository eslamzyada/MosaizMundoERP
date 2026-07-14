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

            if (response.isSuccessful || response.code() in 400..499) {
                // 2xx: submitted (idempotent backend also returns 2xx on a
                // re-delivered order). 4xx: a permanently bad request — stop
                // retrying it rather than loop forever.
                dao.markOrderSynced(order.clientOfflineId)
            } else {
                // 5xx: transient server error, retry later.
                retryNeeded = true
            }
        }

        return if (retryNeeded) Result.retry() else Result.success()
    }
}
