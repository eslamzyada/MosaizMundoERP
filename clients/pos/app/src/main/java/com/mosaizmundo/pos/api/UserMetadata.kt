package com.mosaizmundo.pos.api

/**
 * GET /api/me — who the till is signed in as.
 *
 * [role] decides whether this user can authorise a void themselves. A cashier
 * cannot (the backend gates voiding to managers), so the app asks a manager to
 * sign in for that one action rather than taking over the shift session.
 */
data class UserMetadata(
    val user_id: String,
    val organization_id: String,
    val role: String,
)

/** Roles the backend's ADMIN_ROLES accepts for a void. Keep in step with it. */
val MANAGER_ROLES = setOf("owner", "regional_manager", "branch_manager")
