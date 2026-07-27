package com.mosaizmundo.pos.api

import com.mosaizmundo.pos.data.local.SessionStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import retrofit2.Response as RetrofitResponse

/**
 * Whether a till survives its own access token expiring.
 *
 * This is the most consequential logic in the app and, until the session was
 * put behind an interface, none of it could be tested at all. The bug it exists
 * to prevent was reported from a real device: an hour into use every request
 * began returning 401, the menu emptied, and the screen said to sign out — from
 * an app that had no sign-out. The token could not be renewed because the
 * refresh token was never stored, and could not be discarded because nothing
 * ever cleared it.
 */
class SessionAuthenticatorTest {

    private class FakeSession(
        var access: String? = "old-access",
        var refresh: String? = "refresh-1",
    ) : SessionStore {
        var cleared = false
        override suspend fun accessToken(): String? = access
        override suspend fun refreshToken(): String? = refresh
        override suspend fun saveAccessToken(token: String) { access = token }
        override suspend fun saveRefreshToken(token: String) { refresh = token }
        override suspend fun clear() {
            cleared = true
            access = null
            refresh = null
        }
    }

    /** Answers refreshSession() however a test needs. */
    private class FakeAuthApi(
        private val answer: () -> RetrofitResponse<SupabaseAuthResponse>,
    ) : SupabaseApiService {
        var calls = 0
        override suspend fun signInWithPassword(
            grantType: String,
            payload: SupabaseAuthPayload,
        ): SupabaseAuthResponse = throw UnsupportedOperationException()

        override suspend fun refreshSession(
            grantType: String,
            payload: SupabaseRefreshPayload,
        ): RetrofitResponse<SupabaseAuthResponse> {
            calls += 1
            return answer()
        }
    }

    private fun ok(access: String, refresh: String?) =
        RetrofitResponse.success(
            SupabaseAuthResponse(access, refresh, 3600, SupabaseUser("u-1", "a@b.test")),
        )

    private fun failed(code: Int): RetrofitResponse<SupabaseAuthResponse> =
        RetrofitResponse.error(code, "".toResponseBody("application/json".toMediaType()))

    /** A 401 to a request that carried [sentToken], optionally already retried. */
    private fun unauthorized(
        sentToken: String? = "old-access",
        explicitAuth: Boolean = false,
        priorAttempts: Int = 0,
    ): Response {
        val request = Request.Builder()
            .url("http://localhost/api/pos/menu")
            .apply {
                sentToken?.let { header("Authorization", "Bearer $it") }
                if (explicitAuth) header("X-Explicit-Auth", "true")
            }
            .build()

        fun make(prior: Response?) = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(401)
            .message("Unauthorized")
            .apply { prior?.let { priorResponse(it) } }
            .build()

        var response = make(null)
        repeat(priorAttempts) { response = make(response) }
        return response
    }

    @Test
    fun `an expired token is renewed and the request retried`() {
        val session = FakeSession()
        val api = FakeAuthApi { ok("new-access", "refresh-2") }

        val retry = SessionAuthenticator(session, api).authenticate(null, unauthorized())

        assertNotNull("the request must be retried, not abandoned", retry)
        assertEquals("Bearer new-access", retry!!.header("Authorization"))
        assertEquals("new-access", session.access)
        assertTrue("a renewable session must NOT be signed out", !session.cleared)
    }

    @Test
    fun `the rotated refresh token is stored`() {
        // Supabase issues a new refresh token on every use. Keeping the old one
        // would make the NEXT refresh fail — the same bug, an hour later.
        val session = FakeSession()
        SessionAuthenticator(session, FakeAuthApi { ok("new-access", "refresh-2") })
            .authenticate(null, unauthorized())

        assertEquals("refresh-2", session.refresh)
    }

    @Test
    fun `a session with no refresh token is ended, not left stranded`() {
        // This is the state the reported bug was in: a token that cannot be
        // renewed and nothing that clears it. Clearing sends the app back to
        // the login screen instead of leaving somebody on a screen telling
        // them to do something it does not offer.
        val session = FakeSession(refresh = null)
        val api = FakeAuthApi { ok("unused", null) }

        val retry = SessionAuthenticator(session, api).authenticate(null, unauthorized())

        assertNull(retry)
        assertTrue("the dead session must be cleared", session.cleared)
        assertEquals("and no refresh should have been attempted", 0, api.calls)
    }

    @Test
    fun `a refused refresh ends the session`() {
        val session = FakeSession()
        val retry = SessionAuthenticator(session, FakeAuthApi { failed(401) })
            .authenticate(null, unauthorized())

        assertNull(retry)
        assertTrue(session.cleared)
    }

    @Test
    fun `a network failure during refresh ends the session rather than throwing`() {
        // An Authenticator that throws would surface as a crash mid-service.
        // Signing out is the safe direction: the alternative is a till that
        // looks signed in and cannot sell anything.
        val session = FakeSession()
        val api = object : SupabaseApiService {
            override suspend fun signInWithPassword(
                grantType: String,
                payload: SupabaseAuthPayload,
            ): SupabaseAuthResponse = throw UnsupportedOperationException()

            override suspend fun refreshSession(
                grantType: String,
                payload: SupabaseRefreshPayload,
            ): RetrofitResponse<SupabaseAuthResponse> = throw IOException("no route to host")
        }

        val retry = SessionAuthenticator(session, api).authenticate(null, unauthorized())

        assertNull(retry)
        assertTrue(session.cleared)
    }

    @Test
    fun `it gives up after one retry instead of looping forever`() {
        // A server answering 401 to everything would otherwise have the device
        // refreshing and retrying without end.
        val session = FakeSession()
        val api = FakeAuthApi { ok("new-access", "refresh-2") }

        val retry = SessionAuthenticator(session, api)
            .authenticate(null, unauthorized(priorAttempts = 1))

        assertNull(retry)
        assertEquals("no second refresh", 0, api.calls)
        assertTrue(session.cleared)
    }

    @Test
    fun `a token refreshed by another request is reused without refreshing again`() {
        // Two calls in flight both get a 401; the first refreshes. The second
        // must not burn the newly rotated refresh token on a second exchange.
        val session = FakeSession(access = "already-renewed")
        val api = FakeAuthApi { ok("should-not-be-used", "refresh-9") }

        val retry = SessionAuthenticator(session, api)
            .authenticate(null, unauthorized(sentToken = "old-access"))

        assertEquals("Bearer already-renewed", retry!!.header("Authorization"))
        assertEquals("the stored token was already fresh", 0, api.calls)
        assertTrue(!session.cleared)
    }

    @Test
    fun `a manager's one-off authorisation never signs the cashier out`() {
        // A manager authorising a single void at a cashier's till sends its own
        // token. If that is refused, it is the manager's credentials that are
        // wrong — ending the cashier's shift session over it would be a
        // spectacular piece of collateral damage mid-service.
        val session = FakeSession()
        val api = FakeAuthApi { ok("new-access", "refresh-2") }

        val retry = SessionAuthenticator(session, api)
            .authenticate(null, unauthorized(sentToken = "manager-token", explicitAuth = true))

        assertNull(retry)
        assertTrue("the cashier must stay signed in", !session.cleared)
        assertEquals(0, api.calls)
        assertEquals("old-access", session.access)
    }
}
