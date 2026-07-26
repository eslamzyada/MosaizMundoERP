package com.mosaizmundo.pos.printing

import com.mosaizmundo.pos.domain.ConfiguredPrinter
import com.mosaizmundo.pos.domain.PrinterRole

/**
 * Finds the right printer and sends a ticket to it.
 *
 * The outcome is a value, not an exception, because every failure here is
 * something a server needs told and none of them should stop service:
 *
 *   NO PRINTER CONFIGURED is not an error at all — a restaurant that has not
 *   set one up is using the app exactly as it worked before this feature, and
 *   nagging on every order would train people to ignore the message that
 *   matters.
 *
 *   UNREACHABLE is the one that needs saying loudly, every time, with the
 *   address in it. The food is being made and no ticket exists for it.
 */
class TicketPrinter(
    private val transport: NetworkPrinter = NetworkPrinter(),
    private val render: (Ticket) -> MonoBitmap = { TicketRenderer.render(it) },
) {
    sealed interface Outcome {
        data class Printed(val printerName: String) : Outcome

        /** No active printer for this role. Silent by design. */
        data object NotConfigured : Outcome

        data class Failed(val printerName: String, val message: String) : Outcome
    }

    suspend fun print(
        ticket: Ticket,
        role: PrinterRole,
        printers: List<ConfiguredPrinter>,
    ): Outcome {
        // 0031 guarantees at most one active printer per role, so first() here
        // is not an arbitrary choice among several — it is the only one.
        val printer = printers.firstOrNull { it.role == role } ?: return Outcome.NotConfigured

        return try {
            transport.send(printer.host, printer.port, EscPos.ticket(render(ticket)))
            Outcome.Printed(printer.name)
        } catch (e: PrinterUnreachable) {
            Outcome.Failed(printer.name, e.message ?: "تعذّر الوصول إلى الطابعة")
        } catch (e: Exception) {
            // Rendering or encoding failed rather than the network. Still not
            // fatal to the order, and still something to say out loud.
            Outcome.Failed(printer.name, "تعذّرت طباعة التذكرة")
        }
    }
}
