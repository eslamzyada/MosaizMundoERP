package com.mosaizmundo.pos.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

// One DataStore instance per process, keyed by name.
private val Context.authDataStore: DataStore<Preferences> by preferencesDataStore(name = "pos_auth")

/** Persists the Supabase access token locally via DataStore. */
class TokenManager(private val context: Context) {

    fun getToken(): Flow<String?> =
        context.authDataStore.data.map { prefs -> prefs[ACCESS_TOKEN] }

    suspend fun saveToken(token: String) {
        context.authDataStore.edit { prefs -> prefs[ACCESS_TOKEN] = token }
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
        }
    }

    companion object {
        private val ACCESS_TOKEN = stringPreferencesKey("access_token")
        private val ORGANIZATION_ID = stringPreferencesKey("organization_id")
        private val ROLE = stringPreferencesKey("role")
    }
}
