package com.mosaizmundo.pos.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [OfflineOrderEntity::class], version = 1, exportSchema = false)
abstract class PosDatabase : RoomDatabase() {
    abstract fun offlineOrderDao(): OfflineOrderDao

    companion object {
        @Volatile
        private var instance: PosDatabase? = null

        fun getInstance(context: Context): PosDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    PosDatabase::class.java,
                    "mosaiz_pos.db",
                ).build().also { instance = it }
            }
    }
}
