package com.mosaizmundo.pos.domain

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Taking the payment (0046).
 *
 * One sentence carries the whole feature, and it is the one every test here
 * defends: UNSPECIFIED IS NOT CASH.
 *
 * Sending a guessed 'cash' would give every report a tidy number and make the
 * nightly cash-up a fiction — a fiction somebody acts on, by accusing a cashier
 * of being short. So the till either knows how it was paid or says it does not.
 */
class TenderTest {

    private suspend fun MockPosRepository.aSettleableTab(): OpenTab {
        // The seeded tabs carry unfired lines, which cannot be settled. Fire
        // first, exactly as a server would.
        val tab = openTabs().first()
        fireTab(tab.id)
        return openTabs().first { it.id == tab.id }
    }

    @Test
    fun `the method the till names is what gets recorded`() = runBlocking {
        val repo = MockPosRepository()
        val tab = repo.aSettleableTab()

        repo.settleTab(tab.id, listOf(Tender(PaymentMethod.CARD, tab.totalAmount)))

        assertEquals(listOf(PaymentMethod.CARD), repo.recorded[tab.id]?.map { it.method })
    }

    @Test
    fun `settling without a tender records NOTHING, not cash`() = runBlocking {
        // The escape hatch. It must exist — a till cannot stand between a queue
        // and a closed bill — and it must not quietly become a cash sale.
        val repo = MockPosRepository()
        val tab = repo.aSettleableTab()

        repo.settleTab(tab.id)

        assertEquals(emptyList<Tender>(), repo.recorded[tab.id])
        assertTrue(repo.recorded[tab.id]!!.none { it.method == PaymentMethod.CASH })
    }

    @Test
    fun `a tender that does not add up is refused before the bill closes`() = runBlocking {
        // The mock enforces the same rule the server does, so the demo build
        // cannot teach a habit that breaks in service.
        val repo = MockPosRepository()
        val tab = repo.aSettleableTab()

        try {
            repo.settleTab(tab.id, listOf(Tender(PaymentMethod.CASH, tab.totalAmount - 1)))
            fail("a bill was settled for less than it was worth")
        } catch (e: TabRefusedException) {
            assertEquals(400, e.httpCode)
        }

        // Still open, and nothing recorded against it.
        assertTrue(repo.openTabs().any { it.id == tab.id })
        assertEquals(null, repo.recorded[tab.id])
    }

    @Test
    fun `a bill splits across two tenders`() = runBlocking {
        val repo = MockPosRepository()
        val tab = repo.aSettleableTab()
        val half = Math.round(tab.totalAmount / 2 * 100) / 100.0

        repo.settleTab(
            tab.id,
            listOf(
                Tender(PaymentMethod.CASH, half),
                Tender(PaymentMethod.CARD, Math.round((tab.totalAmount - half) * 100) / 100.0),
            ),
        )

        val recorded = repo.recorded[tab.id]!!
        assertEquals(2, recorded.size)
        assertEquals(
            Math.round(tab.totalAmount * 100) / 100.0,
            Math.round(recorded.sumOf { it.amount } * 100) / 100.0,
            0.0,
        )
    }

    @Test
    fun `the vocabulary matches the database exactly`() {
        // A method the till can name but the server refuses is a refusal that
        // lands in front of a customer holding a card. These five are the
        // CHECK constraint in 0046, verbatim.
        assertEquals(
            listOf("cash", "card", "transfer", "voucher", "other"),
            PaymentMethod.entries.map { it.wire },
        )
    }

    @Test
    fun `there is no UNSPECIFIED member to accidentally count`() {
        // Not naming a method is the ABSENCE of a value, not a value. Modelling
        // it as one is the first step towards it being reported as a kind of
        // payment, which is the exact thing 0046 exists to prevent.
        assertTrue(PaymentMethod.entries.none { it.name.contains("UNSPEC", ignoreCase = true) })
    }
}
