package com.mosaizmundo.pos.api

/**
 * One row of GET /api/printers (0031).
 *
 * The till reads this and opens the socket itself. The API gateway never talks
 * to a printer and could not — the printer is on the restaurant's LAN and the
 * backend may be behind a tunnel somewhere else entirely.
 */
data class PrinterResponse(
    val id: String,
    val name: String,
    /** 'kitchen' or 'receipt' — what the printer is FOR. */
    val role: String,
    val host: String,
    val port: Int,
    val is_active: Boolean,
)
