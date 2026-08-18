package com.mosaizmundo.pos.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/** A checkout that was queued locally (e.g. while offline) awaiting sync. */
@Entity(tableName = "offline_orders")
data class OfflineOrderEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val clientOfflineId: String,
    val payloadJson: String,
    val status: String = "PENDING",

    /**
     * The HTTP status the server answered with, when this sale was refused.
     *
     * The failed-sales screen could say WHICH sales had not arrived and not
     * why — so a cashier could not tell "this dish no longer exists" from
     * "your account lost permission", which are different problems with
     * different people to fetch.
     *
     * Null while the sale is still PENDING: nothing has refused it yet.
     */
    @ColumnInfo(defaultValue = "NULL")
    val failedReason: Int? = null,

    /**
     * When the sale was taken, as epoch milliseconds.
     *
     * A cashier looking at three refused sales needs to know which is this
     * evening's and which has been stuck since Tuesday.
     *
     * Rows queued before this column existed carry 0, which the UI shows as
     * "وقت غير معروف" rather than as 1970 — an obviously wrong date invites
     * somebody to conclude the whole row is wrong.
     */
    @ColumnInfo(defaultValue = "0")
    val queuedAt: Long = 0,
)
