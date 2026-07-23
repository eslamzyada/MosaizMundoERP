package com.mosaizmundo.pos.domain

/**
 * A menu item a cashier can ring up. [imagePlaceholder] stands in for a real
 * product image until asset loading lands (an emoji here).
 */
data class SellableItem(
    val id: String,
    val nameAr: String,
    val price: Double,
    val imagePlaceholder: String,
    /**
     * Portions the recorded stock can still make, or null when nothing tracked
     * constrains this item (no recipe). Advisory only — see MenuItemResponse.
     */
    val portionsAvailable: Int? = null,
)
