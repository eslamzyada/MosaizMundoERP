package com.mosaizmundo.pos.printing

import com.mosaizmundo.pos.domain.OpenTab

/**
 * What a ticket SAYS, separate from how it is drawn or transmitted.
 *
 * Splitting the content out is what makes it testable: whether the kitchen
 * ticket includes a line the kitchen has already cooked is a question about
 * restaurant behaviour, and it should not require a printer, a bitmap or an
 * Android runtime to answer.
 */

/** One printed line, and how much weight to give it. */
data class TicketLine(
    val text: String,
    val emphasis: Emphasis = Emphasis.NORMAL,
) {
    enum class Emphasis {
        /** Ordinary body text. */
        NORMAL,

        /** Larger and bolder: the table, the total — what is read from a distance. */
        HEADING,

        /**
         * An instruction that changes what the cook does. Given its own weight
         * because "بدون بصل" buried in body text beside a dish name is how an
         * allergy gets missed.
         */
        INSTRUCTION,
    }
}

data class Ticket(val lines: List<TicketLine>)

object Tickets {
    /**
     * The kitchen's ticket: ONLY the lines being sent now.
     *
     * A tab that has already had two courses fired must not reprint them when a
     * third is sent — a kitchen that receives a ticket makes what is on it, so
     * reprinting the earlier courses means cooking them twice. This is why the
     * ticket is built from the UNFIRED lines and the caller prints it BEFORE
     * firing, while "unfired" still names the right rows.
     *
     * No prices. A cook does not need them, and money on a ticket that goes out
     * to a kitchen bin is money written down where it need not be.
     */
    fun kitchen(tab: OpenTab, at: String): Ticket {
        val lines = mutableListOf<TicketLine>()
        lines += TicketLine("طلب جديد", TicketLine.Emphasis.HEADING)
        // The TABLE heads the ticket since 0045, because that is what a cook
        // carries the plate to. It used to be the note — free text a server
        // typed — so a ticket could head "حساسية مكسرات" and leave the kitchen
        // holding food for nowhere in particular.
        lines += TicketLine(
            tab.table?.label ?: tab.note ?: "طاولة بدون وصف",
            TicketLine.Emphasis.HEADING,
        )
        // And the note stays, one line down, as what it is for: how this party
        // wants its food, which the cook still needs.
        if (tab.table != null) {
            tab.note?.let { lines += TicketLine(it, TicketLine.Emphasis.INSTRUCTION) }
        }
        lines += TicketLine(at)
        lines += TicketLine("")

        val pending = tab.lines.filter { !it.isFired }
        for (line in pending) {
            lines += TicketLine("${line.quantity} × ${line.name}", TicketLine.Emphasis.HEADING)
            line.note?.let { lines += TicketLine("‹ $it ›", TicketLine.Emphasis.INSTRUCTION) }
        }

        if (pending.isEmpty()) {
            // Should not happen — firing with nothing pending is refused by the
            // server — but a blank ticket coming out of a kitchen printer is
            // worse than one that explains itself.
            lines += TicketLine("لا توجد أصناف للإرسال")
        }
        return Ticket(lines)
    }

    /**
     * The customer's bill: everything on the tab, with prices and a total.
     *
     * Fired and unfired alike, because the customer is paying for the whole
     * table — and by the time a bill prints the server has settled it, which
     * the server refuses while anything is unfired anyway.
     */
    fun receipt(tab: OpenTab, at: String, total: Double): Ticket {
        val lines = mutableListOf<TicketLine>()
        lines += TicketLine("فاتورة", TicketLine.Emphasis.HEADING)
        tab.table?.let { lines += TicketLine(it.label, TicketLine.Emphasis.HEADING) }
        tab.note?.let { lines += TicketLine(it) }
        lines += TicketLine(at)
        lines += TicketLine("")

        for (line in tab.lines) {
            lines += TicketLine(
                "${line.quantity} × ${line.name}   ${money(line.lineTotal)}",
            )
        }

        lines += TicketLine("")
        lines += TicketLine("الإجمالي   ${money(total)} ج.م", TicketLine.Emphasis.HEADING)
        return Ticket(lines)
    }

    private fun money(value: Double): String = String.format(java.util.Locale.US, "%.2f", value)
}
