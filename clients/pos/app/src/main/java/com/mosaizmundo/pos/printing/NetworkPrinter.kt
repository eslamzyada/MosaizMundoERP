package com.mosaizmundo.pos.printing

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Sends bytes to a thermal printer over the LAN (raw port 9100).
 *
 * There is no protocol to speak of: open a socket, write ESC/POS, close. What
 * matters is the TIMEOUTS. A thermal printer that is switched off does not
 * refuse the connection — it usually does not answer at all — and a socket with
 * no connect timeout will sit there for the operating system's default, which
 * on Android is over a minute. A server pressing "send to kitchen" would watch
 * a spinner for that long before being told anything, in the middle of service.
 * So both timeouts are short and deliberate.
 */
class NetworkPrinter(
    private val connectTimeoutMs: Int = 3_000,
    private val writeTimeoutMs: Int = 5_000,
) {
    /**
     * Writes [payload] to the printer, or throws [PrinterUnreachable].
     *
     * The caller decides what a failure means. For a kitchen ticket it must not
     * be fatal: a printer with a jammed roll cannot be allowed to stop a
     * restaurant serving food, so the order is fired anyway and the till says
     * loudly that the ticket did not print.
     */
    suspend fun send(host: String, port: Int, payload: ByteArray) {
        withContext(Dispatchers.IO) {
            try {
                Socket().use { socket ->
                    socket.soTimeout = writeTimeoutMs
                    socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
                    socket.getOutputStream().apply {
                        write(payload)
                        // Explicit: the stream is closed by `use` immediately
                        // after, and an unflushed buffer means a half-printed
                        // ticket, which reads as a complete one.
                        flush()
                    }
                }
            } catch (e: IOException) {
                throw PrinterUnreachable(host, port, e)
            }
        }
    }
}

/**
 * The printer could not be reached or written to.
 *
 * Names the address, because "printing failed" sends somebody looking at the
 * printer when the actual problem is that it moved to a different IP.
 */
class PrinterUnreachable(
    val host: String,
    val port: Int,
    cause: Throwable,
) : Exception("تعذّر الوصول إلى الطابعة على $host:$port", cause)
