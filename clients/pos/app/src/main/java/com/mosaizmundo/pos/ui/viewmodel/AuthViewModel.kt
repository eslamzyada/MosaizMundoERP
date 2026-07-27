package com.mosaizmundo.pos.ui.viewmodel

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mosaizmundo.pos.api.PosApiProvider
import com.mosaizmundo.pos.api.SupabaseApiProvider
import com.mosaizmundo.pos.api.SupabaseAuthPayload
import com.mosaizmundo.pos.data.local.TokenManager
import kotlinx.coroutines.launch

/**
 * Drives the login form. On success it persists the access token, then resolves
 * the user's organization via GET /api/me (authenticated by the just-saved
 * token) and stores it too. MainActivity observes the token and swaps to the
 * menu. If org resolution fails, the token is cleared so login stays atomic.
 */
class AuthViewModel(
    private val tokenManager: TokenManager,
    context: Context,
) : ViewModel() {

    private val authApi = SupabaseApiProvider.create()
    private val posApi = PosApiProvider.create(context)

    var isLoading by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    fun login(email: String, password: String) {
        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            try {
                val response = authApi.signInWithPassword(
                    payload = SupabaseAuthPayload(email.trim(), password),
                )
                tokenManager.saveToken(response.access_token)
                // Without this the session simply ends when the access token
                // expires, roughly an hour later, with no way to renew it.
                response.refresh_token?.let { tokenManager.saveRefreshToken(it) }

                // Token is stored, so the OkHttp interceptor now authenticates
                // this call. Resolve and persist the caller's organization.
                val me = posApi.getMe(authorization = null)
                tokenManager.saveOrganizationId(me.organization_id)
                // The role decides whether this user can authorise a void
                // themselves, or whether a manager has to.
                tokenManager.saveRole(me.role)
            } catch (e: Exception) {
                errorMessage = "تعذّر تسجيل الدخول. تحقّق من البيانات وحاول مجددًا."
                // Keep login atomic — do not leave a token without an org.
                tokenManager.clearToken()
            } finally {
                isLoading = false
            }
        }
    }

    /**
     * Ends the shift.
     *
     * There was no way to do this at all: clearToken() was only ever called
     * after a FAILED login, so once a session expired the app held a dead token
     * forever and the only escape was clearing the app's data. The screen even
     * told people to sign out, which they could not do.
     *
     * Clearing the token is the whole action — MainActivity watches it and
     * shows the login screen the moment it disappears.
     */
    fun logout() {
        viewModelScope.launch {
            tokenManager.clearToken()
        }
    }
}
