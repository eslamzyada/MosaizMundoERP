package com.mosaizmundo.pos.api

import com.mosaizmundo.pos.data.local.SessionStore
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/**
 * Renews an expired session instead of stranding the till.
 *
 * A Supabase ACCESS token is short-lived — an hour by default — and is meant to
 * be exchanged for a new one with the refresh token. The app never kept the
 * refresh token, so it could not do that and had no way to discover it could:
 * an hour into a shift every request began returning 401, the menu emptied, and
 * with no sign-out anywhere the only way back was to clear the app's data.
 *
 * An OkHttp Authenticator is the right hook for this rather than an
 * Interceptor: OkHttp calls it ONLY on a 401, hands it the failed request to
 * rebuild, and retries automatically with whatever it returns. Returning null
 * means "I cannot authenticate this", and the 401 is passed to the caller.
 *
 * TWO THINGS PROTECT AGAINST LOOPING.
 *
 *  - If the request that failed already carried a token DIFFERENT from the
 *    stored one, another thread has refreshed in the meantime; retry with the
 *    stored one rather than refreshing again.
 *  - If the retried request fails too, [responseCount] is 2 and this gives up.
 *    Without that, a server that answers 401 to everything would have the
 *    device retrying forever.
 *
 * When a refresh genuinely cannot succeed the session is CLEARED, which is what
 * makes the app recover on its own: MainActivity watches the stored token and
 * shows the login screen the moment it disappears.
 */
class SessionAuthenticator(
    private val session: SessionStore,
    private val authApi: SupabaseApiService,
) : Authenticator {

    override fun authenticate(route: Route?, response: Response): Request? {
        // A per-call token (a manager authorising one void at a cashier's till)
        // is not this session's to renew, and clearing the shift session over
        // it would be actively wrong.
        if (response.request.header("X-Explicit-Auth") == "true") return null

        if (responseCount(response) >= 2) {
            // Already retried once with a fresh token and still refused. The
            // problem is not the token.
            runBlocking { session.clear() }
            return null
        }

        return runBlocking {
            val stored = session.accessToken()
            val sentWith = response.request.header("Authorization")?.removePrefix("Bearer ")

            // Someone else refreshed while this request was in flight.
            if (!stored.isNullOrBlank() && stored != sentWith) {
                return@runBlocking retryWith(response.request, stored)
            }

            val refreshToken = session.refreshToken()
            if (refreshToken.isNullOrBlank()) {
                // Nothing to renew with — a session from before refresh tokens
                // were stored, or one already signed out. Clearing it sends the
                // user to the login screen instead of leaving them stuck on a
                // screen telling them to do something they cannot.
                session.clear()
                return@runBlocking null
            }

            val refreshed = runCatching {
                authApi.refreshSession(payload = SupabaseRefreshPayload(refreshToken))
            }.getOrNull()

            val body = refreshed?.body()
            if (refreshed == null || !refreshed.isSuccessful || body == null) {
                // A refresh token expires or is revoked eventually; that is the
                // honest end of a session, not an error to hide.
                //
                // A network failure lands here too and signs the user out,
                // which is the safe direction: the alternative is a till that
                // looks signed in and cannot sell anything.
                session.clear()
                return@runBlocking null
            }

            session.saveAccessToken(body.access_token)
            // Supabase rotates the refresh token on use. Keeping the old one
            // would make the NEXT refresh fail and end the session an hour
            // later — the same bug, just delayed.
            body.refresh_token?.let { session.saveRefreshToken(it) }

            retryWith(response.request, body.access_token)
        }
    }

    private fun retryWith(request: Request, token: String): Request =
        request.newBuilder()
            .header("Authorization", "Bearer $token")
            .build()

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) {
            count += 1
            prior = prior.priorResponse
        }
        return count
    }
}
