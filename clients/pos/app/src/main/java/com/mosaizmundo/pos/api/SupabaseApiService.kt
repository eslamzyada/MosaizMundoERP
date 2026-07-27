package com.mosaizmundo.pos.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Query

interface SupabaseApiService {
    // Email/password sign-in. Throws on non-2xx (bad credentials) so the caller
    // can surface an error.
    @POST("auth/v1/token")
    suspend fun signInWithPassword(
        @Query("grant_type") grantType: String = "password",
        @Body payload: SupabaseAuthPayload,
    ): SupabaseAuthResponse

    /**
     * Exchanges a refresh token for a fresh access token.
     *
     * Returns Response rather than throwing: a refresh that fails is the normal
     * end of a session — the refresh token itself eventually expires or is
     * revoked — and the caller has to tell that apart from a network blip to
     * decide whether to sign the user out.
     */
    @POST("auth/v1/token")
    suspend fun refreshSession(
        @Query("grant_type") grantType: String = "refresh_token",
        @Body payload: SupabaseRefreshPayload,
    ): Response<SupabaseAuthResponse>
}
