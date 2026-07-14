package com.mosaizmundo.pos.api

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
}
