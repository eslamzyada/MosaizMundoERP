package com.mosaizmundo.pos.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mosaizmundo.pos.domain.CartItem
import com.mosaizmundo.pos.domain.OrderState
import com.mosaizmundo.pos.domain.PosRepository
import com.mosaizmundo.pos.domain.SellableItem
import com.mosaizmundo.pos.api.MANAGER_ROLES
import com.mosaizmundo.pos.domain.PosOrder
import com.mosaizmundo.pos.domain.VoidReason
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** The screen currently shown in the authenticated POS flow. */
enum class PosDestination { MENU, CART, CHECKOUT, ORDERS }

/** Lifecycle of a checkout submission, observed by the CheckoutScreen. */
enum class CheckoutStatus { IDLE, SUBMITTING, SUCCESS, ERROR }

/**
 * Where a void has got to.
 *
 * Two questions are asked, in this order, and they are not the same question:
 * WHY it is being voided (0022, a fixed vocabulary so voids can be counted),
 * then WHETHER THE FOOD WAS MADE (0018, which decides what happens to the
 * shelf). Why comes first because it is what the person already knows — they
 * are voiding *because* of something.
 *
 * NeedsAuthorisation is the crux: the till is signed in as a cashier all shift,
 * and voiding is manager-only, so the cashier answers both questions and then a
 * manager authorises that one action.
 */
sealed interface VoidState {
    data object Idle : VoidState
    /** An order is chosen; asking why. */
    data class AskingReason(val order: PosOrder) : VoidState
    /** The cause is known; asking whether the food was actually made. */
    data class AskingStockChoice(
        val order: PosOrder,
        val reason: VoidReason,
        val note: String,
    ) : VoidState
    /** Both answers are in; a manager must now authorise it. */
    data class NeedsAuthorisation(
        val order: PosOrder,
        val reason: VoidReason,
        val note: String,
        val restoreStock: Boolean,
        val error: String? = null,
        val checking: Boolean = false,
    ) : VoidState
    data object Working : VoidState
    data class Failed(val message: String) : VoidState
}

/**
 * Holds the menu, the current-order (cart) state, the in-flow navigation
 * destination, and the checkout status — all as StateFlows so Compose recomposes
 * and the state survives configuration changes (it lives in the ViewModel). The
 * repository is injected (MainActivity supplies an HttpPosRepository); pair with
 * a ViewModelProvider.Factory since there is no no-arg constructor.
 */
class PosViewModel(
    private val repository: PosRepository,
    private val managerAuth: ManagerAuth? = null,
    /** The signed-in user's role; a manager skips the authorisation step. */
    roleFlow: Flow<String?> = flowOf(null),
) : ViewModel() {

    private val currentRole: StateFlow<String?> =
        roleFlow.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _menuState = MutableStateFlow<List<SellableItem>>(emptyList())
    val menuState: StateFlow<List<SellableItem>> = _menuState.asStateFlow()

    private val _cartState = MutableStateFlow(OrderState())
    val cartState: StateFlow<OrderState> = _cartState.asStateFlow()

    private val _destination = MutableStateFlow(PosDestination.MENU)
    val destination: StateFlow<PosDestination> = _destination.asStateFlow()

    private val _checkoutStatus = MutableStateFlow(CheckoutStatus.IDLE)
    val checkoutStatus: StateFlow<CheckoutStatus> = _checkoutStatus.asStateFlow()

    private val _orders = MutableStateFlow<List<PosOrder>>(emptyList())
    val orders: StateFlow<List<PosOrder>> = _orders.asStateFlow()

    private val _ordersLoading = MutableStateFlow(false)
    val ordersLoading: StateFlow<Boolean> = _ordersLoading.asStateFlow()

    private val _voidState = MutableStateFlow<VoidState>(VoidState.Idle)
    val voidState: StateFlow<VoidState> = _voidState.asStateFlow()

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

    fun openOrders() {
        _destination.value = PosDestination.ORDERS
        refreshOrders()
    }

    // --- Voiding ------------------------------------------------------------

    fun refreshOrders() {
        viewModelScope.launch {
            _ordersLoading.value = true
            try {
                _orders.value = repository.recentOrders()
            } catch (_: Exception) {
                // Offline or unauthorized: keep whatever list we had rather than
                // blanking the screen mid-shift.
            } finally {
                _ordersLoading.value = false
            }
        }
    }

    /** Step 1: the cashier picks an order. */
    fun beginVoid(order: PosOrder) {
        _voidState.value = VoidState.AskingReason(order)
    }

    /**
     * Step 2: they say why.
     *
     * The note is carried through even when empty; the repository turns blank
     * into null so the stored column is absent rather than an empty string.
     */
    fun chooseReason(reason: VoidReason, note: String) {
        val current = _voidState.value
        if (current !is VoidState.AskingReason) return
        // 'other' without an explanation is refused by the database anyway;
        // stopping here means the cashier finds out now rather than two taps later.
        if (reason.requiresNote && note.isBlank()) return

        _voidState.value = VoidState.AskingStockChoice(current.order, reason, note)
    }

    /**
     * Step 3: they answer "was the food made?".
     *
     * Never derived from the reason. A kitchen error caught at the pass restores
     * stock; a cancellation after plating does not. Guessing would refuse or
     * corrupt a real void.
     *
     * A manager signed in at this terminal goes straight through — making them
     * re-enter their own password to authorise themselves would be theatre.
     * Anyone else has to have a manager authorise it.
     */
    fun chooseStockHandling(restoreStock: Boolean) {
        val current = _voidState.value
        if (current !is VoidState.AskingStockChoice) return

        if (currentRole.value in MANAGER_ROLES) {
            submitVoid(current.order, restoreStock, current.reason, current.note, managerToken = null)
        } else {
            _voidState.value = VoidState.NeedsAuthorisation(
                order = current.order,
                reason = current.reason,
                note = current.note,
                restoreStock = restoreStock,
            )
        }
    }

    /** Step 4: a manager signs in to authorise this one action. */
    fun authoriseVoid(email: String, password: String) {
        val current = _voidState.value
        if (current !is VoidState.NeedsAuthorisation) return
        val auth = managerAuth ?: return

        viewModelScope.launch {
            _voidState.value = current.copy(checking = true, error = null)
            when (val result = auth.authorise(email, password)) {
                is ManagerAuth.Result.Authorised ->
                    submitVoid(
                        current.order,
                        current.restoreStock,
                        current.reason,
                        current.note,
                        result.token,
                    )
                is ManagerAuth.Result.NotAManager ->
                    _voidState.value = current.copy(
                        checking = false,
                        error = "هذا الحساب لا يملك صلاحية الإلغاء.",
                    )
                ManagerAuth.Result.BadCredentials ->
                    _voidState.value = current.copy(
                        checking = false,
                        error = "بيانات الدخول غير صحيحة.",
                    )
            }
        }
    }

    private fun submitVoid(
        order: PosOrder,
        restoreStock: Boolean,
        reason: VoidReason,
        note: String,
        managerToken: String?,
    ) {
        viewModelScope.launch {
            _voidState.value = VoidState.Working
            try {
                // A null token means the signed-in user is themselves a manager,
                // so the stored session authorises the call.
                repository.voidOrder(order.id, restoreStock, reason, note, managerToken)
                _voidState.value = VoidState.Idle
                refreshOrders()
            } catch (e: Exception) {
                _voidState.value = VoidState.Failed("تعذّر إلغاء الطلب. حاول مرة أخرى.")
            }
        }
    }

    fun cancelVoid() { _voidState.value = VoidState.Idle }

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
