package com.mosaizmundo.pos.domain

/**
 * The full state of the order currently being rung up.
 *
 * [note] is context for the WHOLE order — "طاولة ٥", "تيك أواي", an allergy
 * warning. Instructions about a single dish live on that dish's [CartItem.note]
 * instead: collapsing the two would force a cook to read the order's text to
 * find out whether one burger has onions, which is how allergy information gets
 * missed.
 */
data class OrderState(
    val items: List<CartItem> = emptyList(),
    val totalAmount: Double = 0.0,
    val note: String? = null,
)
