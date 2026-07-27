package com.mosaizmundo.pos.api

data class SupabaseAuthPayload(
    val email: String,
    val password: String,
)

data class SupabaseUser(
    val id: String,
    val email: String?,
)

/**
 * What Supabase returns from a sign-in or a refresh.
 *
 * [refresh_token] was previously not modelled at all, so it was parsed away and
 * lost. That single omission is why a till died an hour into a shift: a Supabase
 * ACCESS token is short-lived by design and is meant to be exchanged for a new
 * one using the refresh token, and an app that never kept the refresh token had
 * no way to do that — or to discover that it could.
 *
 * Nullable because a malformed or partial response should surface as "sign in
 * again", not as a crash on a missing field.
 */
data class SupabaseAuthResponse(
    val access_token: String,
    val refresh_token: String?,
    /** Seconds until [access_token] expires. Supabase's default is one hour. */
    val expires_in: Long?,
    val user: SupabaseUser,
)

/** POST /auth/v1/token?grant_type=refresh_token */
data class SupabaseRefreshPayload(
    val refresh_token: String,
)
