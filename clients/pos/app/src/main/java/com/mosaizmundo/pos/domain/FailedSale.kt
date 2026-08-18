package com.mosaizmundo.pos.domain

import com.google.gson.Gson
import com.google.gson.JsonSyntaxException
import com.mosaizmundo.pos.api.CheckoutPayload

/**
 * A queued sale the server refused, in a shape a cashier can act on.
 *
 * The queue stored these all along and showed a number:
 *
 *     "⚠️ 3 طلب لم تتم مزامنته مع الخادم — يرجى المراجعة"
 *
 * "Please review" with nothing to review. No amount, no contents, no way to try
 * again once the cause was fixed — a re-promoted cashier, a re-created dish.
 * The row is money already taken from a customer, and the only thing the app
 * would say about it was how many there were.
 *
 * Everything here is decoded from the payload the queue ALREADY holds, so this
 * costs no schema change. What is deliberately absent is why the server refused
 * and when the sale was taken; both would need columns, and a Room migration in
 * this project cannot currently be tested at all — there is no androidTest
 * source set and no room-testing dependency, and a migration that Room rejects
 * crashes the till on launch rather than degrading. That is worth doing with
 * the test harness first, not in passing.
 */
data class FailedSale(
    /** The idempotency key. Retrying with it is safe by construction. */
    val clientOfflineId: String,
    /** What the customer paid, when it could be read. */
    val totalAmount: Double?,
    /** How many lines were on the bill. */
    val itemCount: Int?,
    /** "طاولة ٥", "تيك أواي" — whatever the cashier typed on the order. */
    val note: String?,
    /** Why the server refused it, in terms of who can fix it. */
    val reason: RefusalReason = RefusalReason.UNKNOWN,
    /**
     * When the sale was taken, epoch millis. 0 for rows queued before the
     * column existed — shown as "unknown", never as 1970, because an obviously
     * wrong date invites somebody to distrust the whole row.
     */
    val queuedAt: Long = 0,
) {
    /** False for a legacy row, which has no stamp to show. */
    val hasTakenAt: Boolean get() = queuedAt > 0

    /**
     * True when the payload could not be read at all.
     *
     * Such a row is still shown. A sale nobody can describe is more alarming
     * than one they can, not less, and hiding the unreadable ones would leave
     * the count and the list disagreeing — which is how somebody concludes the
     * list is the truth and stops looking at the count.
     */
    val isUnreadable: Boolean get() = totalAmount == null
}

/**
 * Decodes a stored payload. Never throws.
 *
 * The worker used to call `gson.fromJson` OUTSIDE its try block, so an
 * unreadable row threw out of doWork() and stopped the whole drain — every
 * other queued sale with it. One bad row must cost only itself.
 */
fun decodeQueuedSale(
    clientOfflineId: String,
    payloadJson: String?,
    gson: Gson = Gson(),
    failedReason: Int? = null,
    queuedAt: Long = 0,
): FailedSale {
    val parsed = try {
        if (payloadJson.isNullOrBlank()) null
        else gson.fromJson(payloadJson, CheckoutPayload::class.java)
    } catch (e: JsonSyntaxException) {
        null
    }

    // Gson does not enforce Kotlin's non-null types. Handed an unrelated
    // object it returns a CheckoutPayload whose `items` is null and whose
    // `total_amount` is the primitive default — so a row of nonsense would
    // otherwise be displayed as a confident "0.00 ج.م، 0 صنف". A sale with no
    // lines is not a sale; saying so is better than inventing a total.
    @Suppress("SENSELESS_COMPARISON")
    val payload = parsed?.takeIf { it.items != null && it.items.isNotEmpty() }

    return FailedSale(
        clientOfflineId = clientOfflineId,
        totalAmount = payload?.total_amount,
        itemCount = payload?.items?.size,
        note = payload?.note?.takeIf { it.isNotBlank() },
        // An unreadable payload is its own explanation, whatever the row says:
        // no server refused it, so no status code describes it.
        reason = if (payload == null && parsed == null) {
            RefusalReason.UNREADABLE
        } else {
            refusalReasonFor(failedReason)
        },
        queuedAt = queuedAt,
    )
}
