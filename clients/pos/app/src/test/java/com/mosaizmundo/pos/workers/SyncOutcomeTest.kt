package com.mosaizmundo.pos.workers

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What happens to money that is already in the till but not yet in the database.
 *
 * The offline queue holds sales a customer has paid for. `FAILED` is not a
 * holding state — it leaves the PENDING set, so the app never delivers that
 * sale again; the row survives for the cashier to see, and that is all. It is
 * the right answer for a sale the server will never accept and the wrong answer
 * for one it merely cannot accept yet.
 *
 * The worker decided this with `response.code() in 400..499 -> markOrderFailed`,
 * which is the wrong axis. The distinction is not 4xx versus 5xx; it is "never"
 * versus "not now", and two ordinary "not now" answers are 4xx.
 *
 * These cases are named for the situation rather than the number, because the
 * number is not the reason.
 */
class SyncOutcomeTest {

    // ---------------------------------------------------------------- delivered

    @Test
    fun `a 201 is delivered`() {
        assertEquals(SyncOutcome.DELIVERED, syncOutcomeFor(201))
    }

    @Test
    fun `a re-delivered order is still delivered`() {
        // The backend is idempotent per client_offline_id, so an order whose
        // response was lost the first time answers 200 the second time. It is
        // in the database; the queue is done with it.
        assertEquals(SyncOutcome.DELIVERED, syncOutcomeFor(200))
    }

    // ------------------------------------------------------------- not now, 4xx

    @Test
    fun `an expired session must NOT destroy the sale`() {
        // THE BUG THIS FILE EXISTS FOR.
        //
        // SessionAuthenticator refreshes and retries on a 401, but when the
        // REFRESH token has expired too it returns null and the 401 arrives at
        // the worker. A till that has been offline is precisely a till whose
        // session has been sitting unused, so the pairing is ordinary rather
        // than exotic — and the old rule marked the sale FAILED, where signing
        // back in would not release it.
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(401))
    }

    @Test
    fun `being rate limited must NOT destroy the sale`() {
        // This worker delivers a BURST: a whole evening's queue at once, the
        // moment connectivity returns. The API rate-limits per IP, and behind a
        // proxy with TRUST_PROXY unset every tenant shares one bucket — the
        // configuration the backend's boot gate warns about rather than
        // refuses. Being told "slow down" would have destroyed real sales.
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(429))
    }

    @Test
    fun `a timeout and a too-early are both requests to ask again`() {
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(408))
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(425))
    }

    // ----------------------------------------------------------------- never, 4xx

    @Test
    fun `a malformed payload is rejected, not retried forever`() {
        // Retrying this until the end of time is how a queue stops draining at
        // all. The row survives so the sale is not silently discarded (F-03).
        assertEquals(SyncOutcome.REJECTED, syncOutcomeFor(400))
    }

    @Test
    fun `a role that changed while the till was offline is a rejection`() {
        // The cashier was demoted mid-shift; the server will refuse this sale
        // every time it is offered. Somebody has to look at it.
        assertEquals(SyncOutcome.REJECTED, syncOutcomeFor(403))
    }

    @Test
    fun `a deleted item is a rejection`() {
        assertEquals(SyncOutcome.REJECTED, syncOutcomeFor(404))
        assertEquals(SyncOutcome.REJECTED, syncOutcomeFor(422))
    }

    // ------------------------------------------------------------------- 5xx

    @Test
    fun `a server fault is retried`() {
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(500))
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(502))
        // 503 is what the API's own readiness answer looks like during a
        // deploy. A rolling restart must not cost a single queued sale.
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(503))
    }

    // --------------------------------------------------------------- the default

    @Test
    fun `an unrecognised status errs towards keeping the sale`() {
        // Retrying a sale that can never be delivered costs a request.
        // Parking one that could have been costs the sale. The asymmetry is
        // the whole reason for the default.
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(0))
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(599))
        assertEquals(SyncOutcome.RETRY, syncOutcomeFor(100))
    }

    /**
     * The guard against the rule quietly becoming "everything retries".
     *
     * Every test above asserts one status. If somebody widened the retryable
     * set to all of 4xx, each RETRY case would still pass and only this would
     * fail — and "the queue never gives up" is its own outage, because a sale
     * the server refuses every time blocks nothing but does hide, forever, in
     * a queue nobody is told to look at.
     */
    @Test
    fun `a permanent refusal is still permanent`() {
        val permanent = listOf(400, 403, 404, 409, 410, 413, 415, 422)
        for (code in permanent) {
            assertEquals(
                "$code must stay a rejection; a queue that never gives up never surfaces the sale",
                SyncOutcome.REJECTED,
                syncOutcomeFor(code),
            )
        }
    }
}
