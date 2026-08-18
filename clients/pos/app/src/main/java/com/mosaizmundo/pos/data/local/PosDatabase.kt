package com.mosaizmundo.pos.data.local

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * Version 2 adds `failedReason` and `queuedAt` (see OfflineOrderEntity).
 *
 * Migrated by an AUTO-migration, not by hand. Room derives it from the
 * committed schemas/1.json and 2.json.
 *
 * WHAT THE BUILD DOES AND DOES NOT CATCH — measured, because the obvious
 * assumption is half wrong:
 *
 *   * a migration Room CANNOT derive fails compilation. Adding a NOT NULL
 *     column with no default stops the build with "New NOT NULL column
 *     'x' added with no default value specified".
 *   * a migration that is simply MISSING does not. Bumping the version and
 *     forgetting the declaration compiles perfectly and throws when a tablet
 *     with the older database opens it — in a restaurant, on launch.
 *
 * MigrationDeclaredTest closes that second gap on the JVM, since this project
 * has no androidTest source set and CI has no emulator. There is deliberately no
 * fallbackToDestructiveMigration: the queue holds sales customers have already
 * paid for, and wiping them to resolve a schema mismatch is never the right
 * answer. Room refuses to open a database it cannot migrate, so the failure is
 * loud rather than silent — one more reason the migration must be generated
 * rather than guessed.
 */
@Database(
    entities = [OfflineOrderEntity::class],
    version = 2,
    exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2)],
)
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
