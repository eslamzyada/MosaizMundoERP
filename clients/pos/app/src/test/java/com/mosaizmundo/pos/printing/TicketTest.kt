package com.mosaizmundo.pos.printing

import com.mosaizmundo.pos.domain.FloorTable
import com.mosaizmundo.pos.domain.OpenTab
import com.mosaizmundo.pos.domain.OpenTabLine
import org.junit.Assert.assertEquals
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
        note = "حساسية مكسرات",
        table = FloorTable("tbl-5", "طاولة ٥", "الصالة", 4),
        totalAmount = lines.sumOf { it.lineTotal },
        openedAt = "2026-07-26T18:00:00Z",
        lines = lines.toList(),
    )

    /** The same party, in a restaurant with no floor plan at all. */
    private fun tabWithoutTable(vararg lines: OpenTabLine) = OpenTab(
        id = "t-2",
        note = "طاولة ٥ — حساسية مكسرات",
        table = null,
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

    @Test
    fun `the kitchen ticket is headed by the TABLE, not by the note`() {
        // What a cook needs off a ticket is where the plate goes. Before 0045
        // this heading was free text a server typed, so it could just as
        // easily have read "حساسية مكسرات" and sent the food nowhere.
        val ticket = Tickets.kitchen(
            tab(OpenTabLine("l-1", "شاورما", 1, 45.0, null, firedAt = null)),
            at = "18:30",
        )
        // Second heading: the first is "طلب جديد", which every ticket carries.
        val headings = ticket.lines
            .filter { it.emphasis == TicketLine.Emphasis.HEADING }
            .map { it.text }

        assertEquals("طاولة ٥", headings[1])
        // The note is not the heading, and it is not lost either — it is how
        // this party wants its food, which the cook still needs.
        assertTrue(headings.none { it.contains("حساسية") })
        assertTrue(ticket.lines.any { it.text.contains("حساسية مكسرات") })
    }

    @Test
    fun `with no floor plan the ticket falls back to the note, as before`() {
        // A takeaway counter runs no reservations module and has no tables.
        // Losing its heading entirely would be a regression for every one of
        // them on the morning this shipped.
        val ticket = Tickets.kitchen(
            tabWithoutTable(OpenTabLine("l-1", "شاورما", 1, 45.0, null, firedAt = null)),
            at = "18:30",
        )
        val headings = ticket.lines
            .filter { it.emphasis == TicketLine.Emphasis.HEADING }
            .map { it.text }

        assertEquals("طاولة ٥ — حساسية مكسرات", headings[1])
    }
}
