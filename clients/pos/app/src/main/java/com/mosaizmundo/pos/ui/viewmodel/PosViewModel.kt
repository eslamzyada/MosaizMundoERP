package com.mosaizmundo.pos.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mosaizmundo.pos.domain.CartItem
import com.mosaizmundo.pos.domain.OrderState
import com.mosaizmundo.pos.domain.PosRepository
import com.mosaizmundo.pos.domain.SellableItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** The screen currently shown in the authenticated POS flow. */
enum class PosDestination { MENU, CART, CHECKOUT }

/** Lifecycle of a checkout submission, observed by the CheckoutScreen. */
enum class CheckoutStatus { IDLE, SUBMITTING, SUCCESS, ERROR }

/**
 * Holds the menu, the current-order (cart) state, the in-flow navigation
 * destination, and the checkout status — all as StateFlows so Compose recomposes
 * and the state survives configuration changes (it lives in the ViewModel). The
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

    private val _destination = MutableStateFlow(PosDestination.MENU)
    val destination: StateFlow<PosDestination> = _destination.asStateFlow()

    private val _checkoutStatus = MutableStateFlow(CheckoutStatus.IDLE)
    val checkoutStatus: StateFlow<CheckoutStatus> = _checkoutStatus.asStateFlow()

    /**
     * How many queued offline sales the server permanently rejected. Surfaced so
     * the cashier is alerted rather than losing a sale silently (analysis F-03).
     */
    val failedOrderCount: StateFlow<Int> =
        repository.failedOrderCount()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)

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

    // --- Navigation ---------------------------------------------------------

    fun openCart() { _destination.value = PosDestination.CART }

    fun openCheckout() { _destination.value = PosDestination.CHECKOUT }

    fun backToMenu() { _destination.value = PosDestination.MENU }

    fun backToCart() { _destination.value = PosDestination.CART }

    // --- Cart editing -------------------------------------------------------

    /** Adds one of [item] to the cart (incrementing if already present). */
    fun addToCart(item: SellableItem) {
        val current = _cartState.value.items
        val updated = if (current.any { it.sellableItem.id == item.id }) {
            current.map { line ->
                if (line.sellableItem.id == item.id) line.copy(quantity = line.quantity + 1) else line
            }
        } else {
            current + CartItem(sellableItem = item, quantity = 1)
        }
        _cartState.value = recompute(updated)
    }

    /** Removes one of [item]; drops the line entirely when it hits zero. */
    fun decrement(item: SellableItem) {
        val updated = _cartState.value.items
            .map { line ->
                if (line.sellableItem.id == item.id) line.copy(quantity = line.quantity - 1) else line
            }
            .filter { it.quantity > 0 }
        _cartState.value = recompute(updated)
    }

    /** Removes [item]'s line from the cart regardless of quantity. */
    fun removeLine(item: SellableItem) {
        val updated = _cartState.value.items.filterNot { it.sellableItem.id == item.id }
        _cartState.value = recompute(updated)
    }

    /** Empties the cart. */
    fun clearCart() {
        _cartState.value = OrderState()
    }

    // --- Checkout -----------------------------------------------------------

    /**
     * Submits the current order and reports progress via [checkoutStatus]. On
     * success the cart is cleared; the CheckoutScreen shows the terminal state
     * and lets the cashier start a new order.
     */
    fun checkout() {
        if (_cartState.value.items.isEmpty() || _checkoutStatus.value == CheckoutStatus.SUBMITTING) {
            return
        }
        viewModelScope.launch {
            _checkoutStatus.value = CheckoutStatus.SUBMITTING
            try {
                repository.submitOrder(_cartState.value)
                _checkoutStatus.value = CheckoutStatus.SUCCESS
                clearCart()
            } catch (_: Exception) {
                // The repository queues offline on IOException, so reaching here
                // means a real server rejection — surface it to the cashier.
                _checkoutStatus.value = CheckoutStatus.ERROR
            }
        }
    }

    /** Resets checkout state to idle (e.g. when leaving the CheckoutScreen). */
    fun resetCheckoutStatus() {
        _checkoutStatus.value = CheckoutStatus.IDLE
    }

    private fun recompute(items: List<CartItem>): OrderState =
        OrderState(
            items = items,
            totalAmount = items.sumOf { it.sellableItem.price * it.quantity },
        )
}
