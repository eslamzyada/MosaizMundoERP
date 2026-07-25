package com.mosaizmundo.pos.domain

import java.util.UUID

/**
 * One line of the current order: a menu item, how many, and how it is wanted.
 *
 * [lineId] exists because a line is NOT identified by its menu item. Two
 * burgers where one has no onions are two different things to cook, so they
 * must be able to sit in the cart as two lines — keying anything on
 * sellableItem.id would silently merge them and throw one instruction away.
 * The database refuses to coalesce them for the same reason (0028).
 *
 * [note] is an instruction for THIS line only ("بدون بصل"). Context for the
 * whole order — a table number, an allergy — belongs on [OrderState.note], so
 * a cook reading one dish does not have to read the entire order to find out
 * about it.
 */
data class CartItem(
    val sellableItem: SellableItem,
    val quantity: Int,
    val note: String? = null,
    val lineId: String = UUID.randomUUID().toString(),
)
