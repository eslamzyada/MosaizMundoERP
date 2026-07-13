package com.mosaizmundo.pos.domain

/**
 * Data-access boundary for the POS. The UI depends only on this interface, so a
 * MockPosRepository (now) can be swapped for an HTTP-backed one (later) with no
 * UI changes.
 */
interface PosRepository {
    suspend fun getMenu(): List<SellableItem>
}
