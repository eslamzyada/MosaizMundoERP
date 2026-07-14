package com.mosaizmundo.pos.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey

/** A checkout that was queued locally (e.g. while offline) awaiting sync. */
@Entity(tableName = "offline_orders")
data class OfflineOrderEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val clientOfflineId: String,
    val payloadJson: String,
    val status: String = "PENDING",
)
