package com.mosaizmundo.pos.api

/**
 * A subset of GET /api/recipes (which returns sellable_items with their bill of
 * materials). The POS menu only needs the item's id and name; Gson ignores the
 * other fields.
 */
data class RecipeResponse(
    val id: String,
    val name: String,
    val price: Double,
)
