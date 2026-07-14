package com.mosaizmundo.pos.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mosaizmundo.pos.domain.CartItem
import com.mosaizmundo.pos.domain.MockPosRepository
import com.mosaizmundo.pos.domain.OrderState
import com.mosaizmundo.pos.domain.PosRepository
import com.mosaizmundo.pos.domain.SellableItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Holds the menu and the current-order (cart) state as StateFlows for Compose.
 * No-arg constructor so Compose's default `viewModel()` factory can build it;
 * the repository is a mock for now (swap for an HTTP-backed one later).
 */
class PosViewModel : ViewModel() {

    private val repository: PosRepository = MockPosRepository()

    private val _menuState = MutableStateFlow<List<SellableItem>>(emptyList())
    val menuState: StateFlow<List<SellableItem>> = _menuState.asStateFlow()

    private val _cartState = MutableStateFlow(OrderState())
    val cartState: StateFlow<OrderState> = _cartState.asStateFlow()

    init {
        viewModelScope.launch {
            _menuState.value = repository.getMenu()
        }
    }

    /** Adds one of [item] to the cart (incrementing if already present). */
    fun addToCart(item: SellableItem) {
        val current = _cartState.value.items
        val alreadyInCart = current.any { it.sellableItem.id == item.id }

        val updatedItems = if (alreadyInCart) {
            current.map { line ->
                if (line.sellableItem.id == item.id) line.copy(quantity = line.quantity + 1) else line
            }
        } else {
            current + CartItem(sellableItem = item, quantity = 1)
        }

        _cartState.value = OrderState(
            items = updatedItems,
            totalAmount = updatedItems.sumOf { it.sellableItem.price * it.quantity },
        )
    }

    /** Empties the cart. */
    fun clearCart() {
        _cartState.value = OrderState()
    }
}
