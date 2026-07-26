package com.mosaizmundo.pos.printing

import com.mosaizmundo.pos.domain.OpenTab
import com.mosaizmundo.pos.domain.OpenTabLine
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What goes ON a ticket.
 *
 * The assertion that matters is the first one: a kitchen ticket carries only
 * the lines being sent NOW. Getting it wrong means a kitchen receiving a ticket
 * listing food it already made and making it a second time — which costs
 * ingredients, a table's patience, and looks to everyone like the system is
 * correct.
 */
class TicketTest {

    private fun tab(vararg lines: OpenTabLine) = OpenTab(
        id = "t-1",
        note = "طاولة ٥ — حساسية مكسرات",
        totalAmount = lines.sumOf { it.lineTotal },
        openedAt = "2026-07-26T18:00:00Z",
        lines = lines.toList(),
    )

    private fun texts(ticket: Ticket) = ticket.lines.map { it.text }

    @Test
    fun `the kitchen ticket lists ONLY what has not been sent`() {
        val ticket = Tickets.kitchen(
            tab(
                OpenTabLine("l-1", "شاورما", 2, 45.0, null, firedAt = "2026-07-26T18:05:00Z"),
                OpenTabLine("l-2", "بطاطس", 1, 20.0, null, firedAt = null),
            ),
            at = "18:30",
        )

        val body = texts(ticket).joinToString("\n")
        assertTrue("the unsent course must be on it", body.contains("بطاطس"))
        assertFalse(
            "a course the kitchen already made must NOT reprint — they would cook it twice",
            body.contains("شاورما"),
        )
    }

    @Test
    fun `the table note is a heading, because it is what identifies the ticket`() {
        val ticket = Tickets.kitchen(
            tab(OpenTabLine("l-1", "بطاطس", 1, 20.0, null, null)),
            at = "18:30",
        )
        val headings = ticket.lines
            .filter { it.emphasis == TicketLine.Emphasis.HEADING }
            .map { it.text }

        assertTrue(headings.any { it.contains("طاولة ٥") })
    }

    @Test
    fun `a line instruction is carried, and given its own weight`() {
        val ticket = Tickets.kitchen(
            tab(OpenTabLine("l-1", "برجر", 1, 65.0, "بدون بصل", null)),
            at = "18:30",
        )

        val instructions = ticket.lines.filter { it.emphasis == TicketLine.Emphasis.INSTRUCTION }
        assertTrue(
            "an instruction buried in body text beside a dish name is how an allergy is missed",
            instructions.any { it.text.contains("بدون بصل") },
        )
    }

    @Test
    fun `the kitchen ticket carries no prices`() {
        val ticket = Tickets.kitchen(
            tab(OpenTabLine("l-1", "برجر", 1, 65.0, null, null)),
            at = "18:30",
        )
        // A cook does not need them, and it puts the takings in the kitchen bin.
        assertFalse(texts(ticket).any { it.contains("65") })
    }

    @Test
    fun `an empty send explains itself rather than printing nothing`() {
        val ticket = Tickets.kitchen(
            tab(OpenTabLine("l-1", "برجر", 1, 65.0, null, firedAt = "2026-07-26T18:05:00Z")),
            at = "18:30",
        )
        // The server refuses this, so it should not happen — but blank paper
        // coming out of a kitchen printer is worse than paper that says why.
        assertTrue(texts(ticket).any { it.contains("لا توجد أصناف") })
    }

    @Test
    fun `the receipt lists everything, priced, with a total`() {
        val ticket = Tickets.receipt(
            tab(
                OpenTabLine("l-1", "شاورما", 2, 45.0, null, "2026-07-26T18:05:00Z"),
                OpenTabLine("l-2", "بطاطس", 1, 20.0, null, "2026-07-26T18:31:00Z"),
            ),
            at = "19:00",
            total = 110.0,
        )
        val body = texts(ticket).joinToString("\n")

        // The customer is paying for the whole table, so fired and unfired
        // alike appear — unlike the kitchen's ticket.
        assertTrue(body.contains("شاورما"))
        assertTrue(body.contains("بطاطس"))
        assertTrue(body.contains("90.00"))
        assertTrue(body.contains("110.00"))
    }
}
