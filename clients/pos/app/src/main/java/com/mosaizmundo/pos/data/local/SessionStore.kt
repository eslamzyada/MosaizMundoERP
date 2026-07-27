package com.mosaizmundo.pos.data.local

/**
 * The stored session, behind an interface.
 *
 * Exists so SessionAuthenticator — which decides whether a till stays usable
 * for the rest of a shift — can be tested on the JVM. TokenManager is backed by
 * DataStore and needs an Android Context; the refresh logic needs neither, and
 * making it depend on one would have put the most consequential code in the app
 * out of reach of any test.
 */
interface SessionStore {
    suspend fun accessToken(): String?
    suspend fun refreshToken(): String?
    suspend fun saveAccessToken(token: String)
    suspend fun saveRefreshToken(token: String)
    /** Ends the session. The app watches this and returns to the login screen. */
    suspend fun clear()
}
