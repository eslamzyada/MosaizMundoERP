package com.mosaizmundo.pos.api

/** GET /api/me — the authenticated user's organization. */
data class UserMetadata(
    val user_id: String,
    val organization_id: String,
)
