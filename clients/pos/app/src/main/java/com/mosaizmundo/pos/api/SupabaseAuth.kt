package com.mosaizmundo.pos.api

data class SupabaseAuthPayload(
    val email: String,
    val password: String,
)

data class SupabaseUser(
    val id: String,
    val email: String?,
)

data class SupabaseAuthResponse(
    val access_token: String,
    val user: SupabaseUser,
)
