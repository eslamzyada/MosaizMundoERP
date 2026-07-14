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

    suspend fun clearToken() {
        context.authDataStore.edit { prefs -> prefs.remove(ACCESS_TOKEN) }
    }

    companion object {
        private val ACCESS_TOKEN = stringPreferencesKey("access_token")
    }
}
