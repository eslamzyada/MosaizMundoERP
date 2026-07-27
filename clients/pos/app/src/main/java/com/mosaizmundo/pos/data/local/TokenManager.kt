package com.mosaizmundo.pos.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

// One DataStore instance per process, keyed by name.
private val Context.authDataStore: DataStore<Preferences> by preferencesDataStore(name = "pos_auth")

/** Persists the Supabase session locally via DataStore. */
class TokenManager(private val context: Context) : SessionStore {

    // --- SessionStore: the subset SessionAuthenticator needs, as suspend
    // functions so it never has to know a Flow (or an Android Context) exists.
    override suspend fun accessToken(): String? = getToken().first()
    override suspend fun refreshToken(): String? = getRefreshToken().first()
    override suspend fun saveAccessToken(token: String) = saveToken(token)
    override suspend fun clear() = clearToken()

    fun getToken(): Flow<String?> =
        context.authDataStore.data.map { prefs -> prefs[ACCESS_TOKEN] }

    suspend fun saveToken(token: String) {
        context.authDataStore.edit { prefs -> prefs[ACCESS_TOKEN] = token }
    }

    /**
     * The long-lived token used to obtain a new access token.
     *
     * Kept beside the access token rather than in place of it: the access token
     * is what every request carries, and the refresh token is only ever sent to
     * Supabase's own auth endpoint.
     */
    fun getRefreshToken(): Flow<String?> =
        context.authDataStore.data.map { prefs -> prefs[REFRESH_TOKEN] }

    override suspend fun saveRefreshToken(token: String) {
        context.authDataStore.edit { prefs -> prefs[REFRESH_TOKEN] = token }
    }

    fun getOrganizationId(): Flow<String?> =
        context.authDataStore.data.map { prefs -> prefs[ORGANIZATION_ID] }

    /** The signed-in user's role, so the app knows whether they may void. */
    fun getRole(): Flow<String?> =
        context.authDataStore.data.map { prefs -> prefs[ROLE] }

    suspend fun saveRole(role: String) {
        context.authDataStore.edit { prefs -> prefs[ROLE] = role }
    }

    suspend fun saveOrganizationId(organizationId: String) {
        context.authDataStore.edit { prefs -> prefs[ORGANIZATION_ID] = organizationId }
    }

    /** Clears the whole session (token + organization + role) — on logout or a failed login. */
    suspend fun clearToken() {
        context.authDataStore.edit { prefs ->
            prefs.remove(ACCESS_TOKEN)
            prefs.remove(ORGANIZATION_ID)
            // Must go too: a stale manager role would let the next cashier to
            // use this terminal void without any authorisation.
            prefs.remove(ROLE)
            // The refresh token too: leaving it behind would let the next
            // person to pick up the terminal resurrect the previous shift's
            // session without ever entering a password.
            prefs.remove(REFRESH_TOKEN)
        }
    }

    companion object {
        private val ACCESS_TOKEN = stringPreferencesKey("access_token")
        private val ORGANIZATION_ID = stringPreferencesKey("organization_id")
        private val ROLE = stringPreferencesKey("role")
        private val REFRESH_TOKEN = stringPreferencesKey("refresh_token")
    }
}
