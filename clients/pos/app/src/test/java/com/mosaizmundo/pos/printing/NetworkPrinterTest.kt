package com.mosaizmundo.pos.printing

import com.mosaizmundo.pos.domain.ConfiguredPrinter
import com.mosaizmundo.pos.domain.PrinterRole
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.CompletableFuture

/**
 * The transport, against a REAL socket.
 *
 * A fake that records calls would prove the code calls itself. Standing up an
 * actual ServerSocket on localhost proves the bytes leave the process in the
 * order and quantity intended, and that a printer which is not there is
 * reported as such rather than hanging — the two failures that matter on a
 * restaurant LAN.
 */
class NetworkPrinterTest {

    /** Accepts one connection and returns everything it was sent. */
    private fun acceptOnce(server: ServerSocket): CompletableFuture<ByteArray> {
        val future = CompletableFuture<ByteArray>()
        Executors.newSingleThreadExecutor().submit {
            try {
                server.accept().use { socket ->
                    future.complete(DataInputStream(socket.getInputStream()).readBytes())
                }
            } catch (e: Exception) {
                future.completeExceptionally(e)
            }
        }
        return future
    }

    @Test
    fun `the exact payload arrives, unaltered`() = runBlocking {
        ServerSocket(0).use { server ->
            val received = acceptOnce(server)
            val payload = EscPos.ticket(MonoBitmap.of(16, 4) { x, y -> (x + y) % 2 == 0 })

            NetworkPrinter().send("127.0.0.1", server.localPort, payload)

            assertArrayEquals(payload, received.get(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `a printer that is not there is reported, not waited on`() = runBlocking {
        // A port nothing is listening on. On a LAN a switched-off printer more
        // often black-holes the connection than refuses it, which is what the
        // connect timeout is for; either way the caller must be told.
        val deadPort = ServerSocket(0).use { it.localPort }

        val started = System.currentTimeMillis()
        val error = runCatching {
            NetworkPrinter(connectTimeoutMs = 1_000).send("127.0.0.1", deadPort, byteArrayOf(1))
        }.exceptionOrNull()
        val elapsed = System.currentTimeMillis() - started

        assertTrue("expected PrinterUnreachable, got $error", error is PrinterUnreachable)
        // The address has to be in the message: "printing failed" sends someone
        // to look at the printer when it has actually moved to another IP.
        assertTrue(error!!.message!!.contains("127.0.0.1"))
        assertTrue(
            "a server in the middle of service cannot wait ${elapsed}ms",
            elapsed < 10_000,
        )
    }

    @Test
    fun `a configured printer is chosen by ROLE and receives the ticket`() = runBlocking {
        ServerSocket(0).use { server ->
            val received = acceptOnce(server)
            val printers = listOf(
                ConfiguredPrinter("p-1", "المطبخ", PrinterRole.KITCHEN, "127.0.0.1", server.localPort),
                // Same address, wrong role: picking this one would send the
                // kitchen's ticket to the till by the counter.
                ConfiguredPrinter("p-2", "الكاشير", PrinterRole.RECEIPT, "127.0.0.1", 1),
            )

            val outcome = TicketPrinter(render = { MonoBitmap.of(8, 1) { _, _ -> true } })
                .print(Ticket(listOf(TicketLine("x"))), PrinterRole.KITCHEN, printers)

            assertEquals(TicketPrinter.Outcome.Printed("المطبخ"), outcome)
            assertTrue(received.get(5, TimeUnit.SECONDS).isNotEmpty())
        }
    }

    @Test
    fun `no printer for the role is silent, not an error`() = runBlocking {
        // A restaurant that has configured nothing is using the app exactly as
        // it worked before printing existed. Warning on every order would train
        // people to ignore the warning that matters.
        val outcome = TicketPrinter().print(
            Ticket(listOf(TicketLine("x"))),
            PrinterRole.KITCHEN,
            printers = listOf(
                ConfiguredPrinter("p-2", "الكاشير", PrinterRole.RECEIPT, "127.0.0.1", 1),
            ),
        )
        assertEquals(TicketPrinter.Outcome.NotConfigured, outcome)
    }

    @Test
    fun `an unreachable printer fails by NAME so somebody can go and look`() = runBlocking {
        val deadPort = ServerSocket(0).use { it.localPort }
        val outcome = TicketPrinter(
            transport = NetworkPrinter(connectTimeoutMs = 500),
            render = { MonoBitmap.of(8, 1) { _, _ -> true } },
        ).print(
            Ticket(listOf(TicketLine("x"))),
            PrinterRole.KITCHEN,
            listOf(ConfiguredPrinter("p-1", "المطبخ", PrinterRole.KITCHEN, "127.0.0.1", deadPort)),
        )

        assertTrue(outcome is TicketPrinter.Outcome.Failed)
        assertEquals("المطبخ", (outcome as TicketPrinter.Outcome.Failed).printerName)
    }
}
