package com.mosaizmundo.pos.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mosaizmundo.pos.domain.CartItem
import com.mosaizmundo.pos.domain.OrderState
import com.mosaizmundo.pos.domain.PosRepository
import com.mosaizmundo.pos.domain.SellableItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Holds the menu and current-order (cart) state as StateFlows for Compose. The
 * repository is injected (MainActivity supplies an HttpPosRepository); pair with
 * a ViewModelProvider.Factory since there is no no-arg constructor.
 */
class PosViewModel(
    private val repository: PosRepository,
) : ViewModel() {

    private val _menuState = MutableStateFlow<List<SellableItem>>(emptyList())
    val menuState: StateFlow<List<SellableItem>> = _menuState.asStateFlow()

    private val _cartState = MutableStateFlow(OrderState())
    val cartState: StateFlow<OrderState> = _cartState.asStateFlow()

    init {
        viewModelScope.launch {
            try {
                _menuState.value = repository.getMenu()
            } catch (_: Exception) {
                // Backend unreachable / unauthorized: leave the menu empty
                // rather than crash. A proper error state comes with POS auth.
            }
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

    /** Submits the current order; clears the cart on success. */
    fun checkout() {
        viewModelScope.launch {
            try {
                repository.submitOrder(_cartState.value)
                clearCart()
            } catch (_: Exception) {
                // TODO: surface a failure toast/state to the cashier in a later phase.
            }
        }
    }

    /** Empties the cart. */
    fun clearCart() {
        _cartState.value = OrderState()
    }
}
