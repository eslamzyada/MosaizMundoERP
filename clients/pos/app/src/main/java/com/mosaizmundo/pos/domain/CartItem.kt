package com.mosaizmundo.pos.domain

/** One line of the current order: a menu item and how many are in the cart. */
data class CartItem(
    val sellableItem: SellableItem,
    val quantity: Int,
)
