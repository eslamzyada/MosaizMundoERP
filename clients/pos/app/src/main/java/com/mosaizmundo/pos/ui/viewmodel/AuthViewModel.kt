package com.mosaizmundo.pos.ui.viewmodel

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mosaizmundo.pos.api.SupabaseApiProvider
import com.mosaizmundo.pos.api.SupabaseAuthPayload
import com.mosaizmundo.pos.data.local.TokenManager
import kotlinx.coroutines.launch

/**
 * Drives the login form. On success it persists the access token via
 * TokenManager; MainActivity observes the token and swaps to the menu.
 */
class AuthViewModel(private val tokenManager: TokenManager) : ViewModel() {

    private val authApi = SupabaseApiProvider.create()

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
            } catch (e: Exception) {
                errorMessage = "تعذّر تسجيل الدخول. تحقّق من البريد وكلمة المرور."
            } finally {
                isLoading = false
            }
        }
    }
}
