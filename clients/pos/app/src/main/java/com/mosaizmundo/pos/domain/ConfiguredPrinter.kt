package com.mosaizmundo.pos.domain

/** A printer this till can reach, as configured for the organization (0031). */
data class ConfiguredPrinter(
    val id: String,
    val name: String,
    val role: PrinterRole,
    val host: String,
    val port: Int,
)

enum class PrinterRole(val code: String) {
    KITCHEN("kitchen"),
    RECEIPT("receipt");

    companion object {
        /**
         * Null for anything unrecognised rather than throwing. A newer backend
         * could add a role this build has never heard of, and a till that
         * crashed on reading the printer list would be worse than one that
         * ignores a machine it does not understand.
         */
        fun from(code: String): PrinterRole? = entries.firstOrNull { it.code == code }
    }
}
