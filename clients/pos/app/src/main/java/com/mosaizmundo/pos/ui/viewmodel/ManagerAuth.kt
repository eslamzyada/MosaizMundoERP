package com.mosaizmundo.pos.ui.viewmodel

import com.mosaizmundo.pos.api.MANAGER_ROLES
import com.mosaizmundo.pos.api.PosApiService
import com.mosaizmundo.pos.api.SupabaseApiProvider
import com.mosaizmundo.pos.api.SupabaseAuthPayload

/**
 * Obtains a manager's token for a single privileged action at the till.
 *
 * A terminal is signed in as a cashier for a whole shift, but voiding is
 * manager-only. Rather than making the manager take over the session — signing
 * the cashier out and back in around every correction — they authorise the one
 * action and the token is used once and dropped.
 *
 * The token is deliberately NOT written to TokenManager: it must not outlive
 * the action it authorised, and the cashier's shift session must survive it.
 */
class ManagerAuth(private val posApi: PosApiService) {

    private val authApi = SupabaseApiProvider.create()

    sealed interface Result {
        /** Authorised. [token] is for one call and must not be stored. */
        data class Authorised(val token: String) : Result
        /** The credentials were wrong, or the network is down. */
        data object BadCredentials : Result
        /** They signed in, but this person cannot authorise a void. */
        data class NotAManager(val role: String) : Result
    }

    suspend fun authorise(email: String, password: String): Result {
        val token = try {
            authApi.signInWithPassword(
                payload = SupabaseAuthPayload(email.trim(), password),
            ).access_token
        } catch (e: Exception) {
            return Result.BadCredentials
        }

        // Check the role before letting the caller proceed, so a non-manager
        // gets a clear answer instead of an opaque 403 from the void itself.
        // The backend gate remains the real boundary — this is only a better
        // message, and cannot grant anything the server would refuse.
        return try {
            val me = posApi.getMe(authorization = "Bearer $token")
            if (me.role in MANAGER_ROLES) Result.Authorised(token) else Result.NotAManager(me.role)
        } catch (e: Exception) {
            Result.BadCredentials
        }
    }
}
