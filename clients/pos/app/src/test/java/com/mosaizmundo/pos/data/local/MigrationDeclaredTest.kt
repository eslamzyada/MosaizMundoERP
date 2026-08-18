package com.mosaizmundo.pos.data.local

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every version step must have a migration, and the compiler will not say so.
 *
 * Measured while building this: Room fails the BUILD for a migration it cannot
 * derive — a NOT NULL column with no default stops compilation with a precise
 * message. But a migration that is simply MISSING compiles perfectly. Bumping
 * the version and forgetting the declaration produces a working build and an
 * IllegalStateException the first time a tablet holding the older database
 * opens it, on launch, in a restaurant.
 *
 * That failure mode is the reason `fallbackToDestructiveMigration` is absent
 * and must stay absent — the queue holds sales customers have already paid for,
 * so a crash is the correct alternative to deleting them. It also means the
 * crash is the only signal, which is far too late.
 *
 * This asserts on the artefacts of a successful migration rather than the
 * intent: for every consecutive pair of exported schemas, Room must have
 * GENERATED the migration class.
 */
class MigrationDeclaredTest {

    private val schemaDir =
        File("schemas/com.mosaizmundo.pos.data.local.PosDatabase")

    private fun exportedVersions(): List<Int> =
        schemaDir.listFiles()
            .orEmpty()
            .mapNotNull { it.name.removeSuffix(".json").toIntOrNull() }
            .sorted()

    @Test
    fun `schemas are exported at all`() {
        // exportSchema = false was the state before this work, and with it Room
        // can derive nothing and this whole file would be vacuous.
        assertTrue(
            "no exported schemas found in ${schemaDir.absolutePath}; is exportSchema still true?",
            exportedVersions().isNotEmpty(),
        )
    }

    @Test
    fun `every consecutive version step has a generated migration`() {
        val versions = exportedVersions()
        assertTrue("expected at least two schema versions to compare", versions.size >= 2)

        for ((from, to) in versions.zipWithNext()) {
            val generated = "com.mosaizmundo.pos.data.local.PosDatabase_AutoMigration_${from}_${to}_Impl"
            val found = try {
                Class.forName(generated)
                true
            } catch (e: ClassNotFoundException) {
                false
            }
            assertTrue(
                "schemas $from.json and $to.json both exist but Room generated no migration " +
                    "between them. A tablet holding version $from will CRASH ON LAUNCH. " +
                    "Declare AutoMigration(from = $from, to = $to) on @Database — or, if the " +
                    "change cannot be automatic, a hand-written Migration and an update to this test.",
                found,
            )
        }
    }

    @Test
    fun `the exported versions are contiguous from 1`() {
        // A gap means a schema file was deleted, and a deleted schema is a
        // migration path that can never be reconstructed.
        val versions = exportedVersions()
        assertTrue("schema versions must start at 1, found $versions", versions.first() == 1)
        assertTrue(
            "schema versions must be contiguous, found $versions",
            versions == (1..versions.size).toList(),
        )
    }
}
