package com.mosaizmundo.pos.domain

import com.google.gson.Gson
import com.mosaizmundo.pos.api.CheckoutItemPayload
import com.mosaizmundo.pos.api.CheckoutPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Turning a stored payload back into something a cashier can recognise.
 *
 * The queue held these rows all along and the app would only say how many there
 * were. Each one is money already taken from a customer, so "3 sales did not
 * sync — please review" was an instruction with nothing behind it.
 *
 * The decode must never throw. It runs inside the drain, where an exception
 * used to escape doWork() and stop EVERY remaining sale from being delivered.
 */
class FailedSaleTest {

    private val gson = Gson()

    private fun payload(
        total: Double = 145.50,
        items: Int = 3,
        note: String? = null,
    ) = gson.toJson(
        CheckoutPayload(
            organization_id = "11111111-1111-4111-8111-111111111111",
            client_offline_id = "c0ffee00-0000-4000-8000-000000000001",
            total_amount = total,
            items = (1..items).map {
                CheckoutItemPayload(
                    sellable_item_id = "s$it",
                    quantity = 1,
                    unit_price = total / items,
                )
            },
            note = note,
        ),
    )

    @Test
    fun `a stored sale gives back its total and its size`() {
        val sale = decodeQueuedSale("c-1", payload(total = 145.50, items = 3), gson)

        assertEquals(145.50, sale.totalAmount!!, 0.001)
        assertEquals(3, sale.itemCount)
        assertFalse(sale.isUnreadable)
    }

    @Test
    fun `the order note survives, because it is how a cashier recognises the sale`() {
        // "طاولة ٥" is far more use than a uuid when somebody is trying to
        // remember which sale this was.
        val sale = decodeQueuedSale("c-1", payload(note = "طاولة ٥"), gson)
        assertEquals("طاولة ٥", sale.note)
    }

    @Test
    fun `a blank note is no note`() {
        assertNull(decodeQueuedSale("c-1", payload(note = "   "), gson).note)
    }

    @Test
    fun `the idempotency key is carried through, because retrying depends on it`() {
        // Retry re-sends the sale under its ORIGINAL client_offline_id. That is
        // what makes the button safe: a sale the server already recorded comes
        // back 2xx as a no-op instead of charging twice.
        val sale = decodeQueuedSale("the-original-key", payload(), gson)
        assertEquals("the-original-key", sale.clientOfflineId)
    }

    // ------------------------------------------------------------- poison rows

    @Test
    fun `malformed json does not throw, it reports an unreadable sale`() {
        // THE CASE THAT USED TO STOP THE WHOLE QUEUE. The worker called
        // gson.fromJson OUTSIDE its try block, so one unreadable row threw out
        // of doWork() and every OTHER queued sale stopped being delivered.
        val sale = decodeQueuedSale("c-1", "{not json at all", gson)

        assertTrue(sale.isUnreadable)
        assertNull(sale.totalAmount)
        // Still identifiable, which is the whole point of keeping the row.
        assertEquals("c-1", sale.clientOfflineId)
    }

    @Test
    fun `an empty payload is unreadable rather than an exception`() {
        assertTrue(decodeQueuedSale("c-1", "", gson).isUnreadable)
        assertTrue(decodeQueuedSale("c-1", "   ", gson).isUnreadable)
        assertTrue(decodeQueuedSale("c-1", null, gson).isUnreadable)
    }

    @Test
    fun `json that parses but is not a checkout is unreadable`() {
        // Gson is lenient: it will happily produce a CheckoutPayload from an
        // unrelated object, leaving the fields at their defaults. A sale with
        // no total is not a sale anybody can act on, so it is reported as
        // unreadable rather than as a confident 0.00.
        val sale = decodeQueuedSale("c-1", """{"something":"else"}""", gson)
        assertTrue("an object with no total must not read as a 0.00 sale", sale.isUnreadable)
    }

    @Test
    fun `an unreadable sale is still listed, never hidden`() {
        // Hiding it would leave the list disagreeing with the banner's count,
        // which is how somebody decides the warning is noise. isUnreadable is
        // a display decision, not a filter.
        val sale = decodeQueuedSale("c-1", "{oops", gson)
        assertTrue(sale.isUnreadable)
        assertEquals("c-1", sale.clientOfflineId)
    }
}
