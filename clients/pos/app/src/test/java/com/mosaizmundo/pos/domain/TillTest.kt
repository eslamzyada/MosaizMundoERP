package com.mosaizmundo.pos.domain

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The drawer, from the till's side (0047).
 *
 * The server owns the arithmetic and these do not re-implement it. What they
 * defend is that the till AGREES with it — a till that let a second drawer be
 * opened, or that quietly counted card money into the drawer, would collect
 * refusals or produce a shortfall in front of somebody at the end of a shift.
 *
 * The mock is the subject because it is what the demo build and every preview
 * run against. A mock more permissive than the server teaches a habit that
 * breaks in service.
 */
class TillTest {

    private suspend fun MockPosRepository.settleOneFor(method: PaymentMethod): Double {
        val tab = openTabs().first()
        fireTab(tab.id)
        val fresh = openTabs().first { it.id == tab.id }
        settleTab(fresh.id, listOf(Tender(method, fresh.totalAmount)))
        return fresh.totalAmount
    }

    @Test
    fun `no drawer open is NULL, not an empty session`() = runBlocking {
        // "Closed" and "an open drawer holding nothing" are different facts, and
        // only one of them means somebody still has to open it.
        assertNull(MockPosRepository().till())
    }

    @Test
    fun `opening starts from the float that is already in it`() = runBlocking {
        val repo = MockPosRepository()

        val open = repo.openTill(200.0)

        assertEquals(200.0, open!!.openingFloat, 0.0)
        assertEquals(200.0, open.expectedSoFar, 0.0)
    }

    @Test
    fun `a second drawer is refused`() = runBlocking {
        // The server enforces this with a partial unique index. A till that let
        // it through would split a night's cash across two sessions.
        val repo = MockPosRepository()
        repo.openTill(0.0)

        try {
            repo.openTill(0.0)
            fail("a second drawer was opened")
        } catch (e: TabRefusedException) {
            assertEquals(409, e.httpCode)
        }
    }

    @Test
    fun `cash taken raises what should be in the drawer`() = runBlocking {
        val repo = MockPosRepository()
        repo.openTill(100.0)

        val taken = repo.settleOneFor(PaymentMethod.CASH)

        assertEquals(taken, repo.till()!!.cashTaken, 0.01)
        assertEquals(100.0 + taken, repo.till()!!.expectedSoFar, 0.01)
    }

    @Test
    fun `CARD money is reported but is NOT in the drawer`() = runBlocking {
        // The one that matters. Counting card here produces a shortfall exactly
        // the size of the day's card takings, and sends somebody looking for
        // money that was never in the room.
        val repo = MockPosRepository()
        repo.openTill(100.0)

        val taken = repo.settleOneFor(PaymentMethod.CARD)

        assertEquals(100.0, repo.till()!!.expectedSoFar, 0.01)
        assertEquals(0.0, repo.till()!!.cashTaken, 0.01)
        // Reported, though — it is real revenue, just not here.
        assertEquals(taken, repo.till()!!.otherTaken, 0.01)
    }

    @Test
    fun `counting exactly right balances`() = runBlocking {
        val repo = MockPosRepository()
        repo.openTill(100.0)
        val taken = repo.settleOneFor(PaymentMethod.CASH)

        val count = repo.closeTill(100.0 + taken)

        assertTrue(count.balances)
        assertEquals(0.0, count.variance, 0.0)
    }

    @Test
    fun `short is negative and over is positive, and both are reported`() = runBlocking {
        // Over is NOT good news — it usually means a sale nobody rang up — so
        // the two are distinguished rather than one being treated as fine.
        val short = MockPosRepository().let { repo ->
            repo.openTill(100.0)
            repo.closeTill(90.0)
        }
        assertEquals(-10.0, short.variance, 0.0)
        assertTrue(short.isShort)

        val over = MockPosRepository().let { repo ->
            repo.openTill(100.0)
            repo.closeTill(130.0)
        }
        assertEquals(30.0, over.variance, 0.0)
        assertTrue(!over.isShort)
        assertTrue(!over.balances)
    }

    @Test
    fun `closing shuts the drawer, and it cannot be closed twice`() = runBlocking {
        val repo = MockPosRepository()
        repo.openTill(0.0)
        repo.closeTill(0.0)

        assertNull(repo.till())

        try {
            repo.closeTill(0.0)
            fail("a drawer that was not open was closed")
        } catch (e: TabRefusedException) {
            assertEquals(409, e.httpCode)
        }
    }

    @Test
    fun `a fresh drawer does not inherit the last one's takings`() = runBlocking {
        // Otherwise every shift after the first opens already looking over by
        // the previous shift's cash.
        val repo = MockPosRepository()
        repo.openTill(50.0)
        repo.settleOneFor(PaymentMethod.CASH)
        repo.closeTill(0.0)

        val second = repo.openTill(50.0)
        assertEquals(0.0, second!!.cashTaken, 0.0)
        assertEquals(50.0, second.expectedSoFar, 0.0)

        // And — the half that actually bites — it must still be true at the
        // CLOSE. The session a fresh open hands back is built with zeros
        // whatever the running counters hold, so asserting on it alone passes
        // even when the previous shift's cash is still being carried.
        val count = repo.closeTill(50.0)
        assertEquals(50.0, count.expectedCash, 0.0)
        assertTrue("the new shift inherited the last one's takings", count.balances)
    }
}
