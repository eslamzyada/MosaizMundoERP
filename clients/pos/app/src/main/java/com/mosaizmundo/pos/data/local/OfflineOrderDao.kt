package com.mosaizmundo.pos.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface OfflineOrderDao {
    @Insert
    suspend fun insertOrder(order: OfflineOrderEntity)

    @Query("SELECT * FROM offline_orders WHERE status = 'PENDING' ORDER BY id ASC")
    suspend fun getPendingOrders(): List<OfflineOrderEntity>

    /**
     * A successfully-synced order has served its purpose (the server has it, and
     * re-POSTing is an idempotent no-op), so remove it. This keeps the local
     * queue from growing without bound over the life of the install (F-09).
     */
    @Query("DELETE FROM offline_orders WHERE clientOfflineId = :clientOfflineId")
    suspend fun deleteOrder(clientOfflineId: String)

    /**
     * The server PERMANENTLY rejected this order (a 4xx). Mark it FAILED rather
     * than deleting it — a sale must never be silently discarded (F-03). It is
     * no longer PENDING, so getPendingOrders() won't retry it in a loop, and it
     * surfaces to the cashier through [failedCount].
     */
    @Query("UPDATE offline_orders SET status = 'FAILED' WHERE clientOfflineId = :clientOfflineId")
    suspend fun markOrderFailed(clientOfflineId: String)

    /** Live count of orders that failed to sync, for the cashier-facing alert. */
    @Query("SELECT COUNT(*) FROM offline_orders WHERE status = 'FAILED'")
    fun failedCount(): Flow<Int>
}
