package com.mosaizmundo.pos.domain

import com.mosaizmundo.pos.workers.SyncOrdersWorker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Telling a cashier who can fix a refused sale.
 *
 * The screen could say which sales had not arrived and not why, so "this dish
 * no longer exists" and "your account lost permission" looked identical — two
 * different problems needing two different people, and only one of them worth
 * pressing retry on before anybody does anything.
 *
 * The grouping is by ACTION, not by status code. Nobody at a till cares that it
 * was a 403; they care that a manager has to come over.
 */
class RefusalReasonTest {

    @Test
    fun `a lost permission points at the manager, not at the sale`() {
        assertEquals(RefusalReason.PERMISSION, refusalReasonFor(403))
        assertTrue(RefusalReason.PERMISSION.message.contains("المدير"))
    }

    @Test
    fun `a 401 that reached this far is still a permission problem`() {
        // The drain retries a 401 rather than failing it (#116), so this only
        // describes a row recorded before that fix — which is exactly the kind
        // of stranded sale this screen exists to surface.
        assertEquals(RefusalReason.PERMISSION, refusalReasonFor(401))
    }

    @Test
    fun `a deleted item says so, because the fix is on the menu screen`() {
        assertEquals(RefusalReason.MISSING_ITEM, refusalReasonFor(404))
        assertEquals(RefusalReason.MISSING_ITEM, refusalReasonFor(410))
    }

    @Test
    fun `a refused payload sends somebody to the office with a reference`() {
        for (code in listOf(400, 409, 413, 415, 422)) {
            assertEquals("$code", RefusalReason.REJECTED_DATA, refusalReasonFor(code))
        }
    }

    @Test
    fun `an unreadable payload is its own explanation`() {
        // No server ever saw it, so no HTTP status describes it. Saying "the
        // server refused this" would send somebody looking for a refusal that
        // never happened.
        assertEquals(RefusalReason.UNREADABLE, refusalReasonFor(SyncOrdersWorker.UNREADABLE_PAYLOAD))
    }

    @Test
    fun `a row from before the column existed is UNKNOWN, not an error`() {
        // These are the OLDEST sales in the queue, and the most stranded. They
        // must be listed with an honest "we do not know why", never dropped
        // because the reason is missing.
        val reason = refusalReasonFor(null)
        assertEquals(RefusalReason.UNKNOWN, reason)
        assertTrue("an unexplained sale is worth one retry", reason.retryLikelyToHelp)
    }

    @Test
    fun `an unrecognised code is UNKNOWN rather than a crash`() {
        assertEquals(RefusalReason.UNKNOWN, refusalReasonFor(418))
        assertEquals(RefusalReason.UNKNOWN, refusalReasonFor(0))
    }

    /**
     * The guard on the advice itself.
     *
     * `retryLikelyToHelp` decides whether the message reads as "try again" or
     * as "fetch somebody first". Getting it backwards on PERMISSION would tell
     * a cashier to keep pressing a button that cannot work until a manager acts.
     */
    @Test
    fun `only the unexplained case suggests retrying immediately`() {
        assertFalse(RefusalReason.PERMISSION.retryLikelyToHelp)
        assertFalse(RefusalReason.MISSING_ITEM.retryLikelyToHelp)
        assertFalse(RefusalReason.REJECTED_DATA.retryLikelyToHelp)
        assertFalse(RefusalReason.UNREADABLE.retryLikelyToHelp)
        assertTrue(RefusalReason.UNKNOWN.retryLikelyToHelp)
    }

    @Test
    fun `every reason actually says something in Arabic`() {
        // A blank or placeholder message would render as an empty line under
        // the amount, which reads as "no reason given" rather than as a bug.
        for (reason in RefusalReason.values()) {
            assertTrue("${reason.name} has no message", reason.message.length > 20)
            assertTrue("${reason.name} is not Arabic", reason.message.any { it in '؀'..'ۿ' })
        }
    }
}
