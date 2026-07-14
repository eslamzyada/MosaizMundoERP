package com.mosaizmundo.pos.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface OfflineOrderDao {
    @Insert
    suspend fun insertOrder(order: OfflineOrderEntity)

    @Query("SELECT * FROM offline_orders WHERE status = 'PENDING' ORDER BY id ASC")
    suspend fun getPendingOrders(): List<OfflineOrderEntity>

    @Query("UPDATE offline_orders SET status = 'SYNCED' WHERE clientOfflineId = :clientOfflineId")
    suspend fun markOrderSynced(clientOfflineId: String)
}
