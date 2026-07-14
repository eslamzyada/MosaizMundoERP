package com.mosaizmundo.pos.domain

/** The full state of the order currently being rung up. */
data class OrderState(
    val items: List<CartItem> = emptyList(),
    val totalAmount: Double = 0.0,
)
