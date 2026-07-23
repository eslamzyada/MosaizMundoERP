package com.mosaizmundo.pos.domain

/**
 * A past order as the till sees it. [lineSummary] is what a cashier actually
 * scans for — "برجر لحم x2" identifies an order in a way a total never can,
 * since two orders can easily share one.
 */
data class PosOrder(
    val id: String,
    val status: String,
    val totalAmount: Double,
    val createdAt: String,
    val lineSummary: String,
    val stockRestored: Boolean?,
) {
    val isVoided: Boolean get() = status == "voided"
}
