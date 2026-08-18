package com.mosaizmundo.pos.workers

/**
 * What to do with a queued sale after the server has answered.
 *
 * This is a pure function over an HTTP status, separated from the worker for
 * two reasons. It is the most consequential decision in the application — the
 * money in the queue is money already taken from a customer — and inside a
 * CoroutineWorker it could only be exercised with a WorkManager test harness,
 * which is why it was never exercised at all.
 *
 * ----------------------------------------------------------------------------
 * WHAT WAS WRONG.
 *
 * The worker treated EVERY 4xx as permanent:
 *
 *     response.code() in 400..499 -> dao.markOrderFailed(...)
 *
 * FAILED is not a holding state. It leaves the PENDING set, so the queue never
 * retries it; the sale stays visible to the cashier and is never delivered
 * again by the app. That is right for a sale the server will never accept, and
 * wrong for one it merely cannot accept YET — and two of those are ordinary:
 *
 *   * 401. SessionAuthenticator refreshes and retries on a 401, but when the
 *     REFRESH token has also expired it returns null and the 401 arrives here.
 *     A till that has been offline is exactly a till whose session has been
 *     sitting unused, so this is not a rare pairing. The sale would be parked
 *     permanently, and signing back in would not release it.
 *
 *   * 429. The API rate-limits per IP, and this worker delivers a BURST — a
 *     whole evening's queue at once, after connectivity returns. Behind a proxy
 *     with TRUST_PROXY unset, every tenant shares one bucket, which is the
 *     configuration the backend's boot gate warns about rather than refuses.
 *     Being told "slow down" would have destroyed the sale instead.
 *
 * 408 and 425 are the same shape: the server is asking for the request again.
 *
 * ----------------------------------------------------------------------------
 * The distinction is not 4xx versus 5xx. It is "this will never be accepted"
 * versus "not now" — so an unrecognised status is treated as RETRY, because
 * retrying a sale that cannot be delivered costs a request, and parking one
 * that could have been costs the sale.
 */
enum class SyncOutcome {
    /** Delivered, or already known to the server. Remove it from the queue. */
    DELIVERED,

    /**
     * The server will never accept this: a malformed payload, a deleted item,
     * a role that changed while the till was offline. Keep the row and stop
     * retrying — a sale is never silently discarded (F-03).
     */
    REJECTED,

    /** Not now. Leave it PENDING and let WorkManager bring it back. */
    RETRY,
}

/**
 * Statuses that mean "ask again", despite being 4xx.
 *
 * Written as an explicit set rather than a range so that adding one is a
 * deliberate act with a reason, and so the test can name each.
 */
private val RETRYABLE_CLIENT_ERRORS = setOf(
    401,  // the session expired while the till was offline; signing in fixes it
    408,  // request timeout — the server is asking for it again
    425,  // too early
    429,  // rate limited, which a queue drain is unusually good at triggering
)

fun syncOutcomeFor(statusCode: Int): SyncOutcome = when {
    // The backend is idempotent per client_offline_id, so a re-delivered order
    // answers 2xx as well. Both mean the server has it.
    statusCode in 200..299 -> SyncOutcome.DELIVERED
    statusCode in RETRYABLE_CLIENT_ERRORS -> SyncOutcome.RETRY
    statusCode in 400..499 -> SyncOutcome.REJECTED
    // 5xx, and anything unrecognised. Erring towards RETRY costs a request;
    // erring the other way costs the sale.
    else -> SyncOutcome.RETRY
}
