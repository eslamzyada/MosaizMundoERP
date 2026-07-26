package com.mosaizmundo.pos.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mosaizmundo.pos.domain.CartItem
import com.mosaizmundo.pos.domain.OpenTab
import com.mosaizmundo.pos.domain.TabRefusedException
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
import java.io.IOException

/** The screen currently shown in the authenticated POS flow. */
enum class PosDestination { MENU, CART, CHECKOUT, ORDERS, TABS }

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

    // --- Open tabs (0029) ---------------------------------------------------

    private val _tabs = MutableStateFlow<List<OpenTab>>(emptyList())
    val tabs: StateFlow<List<OpenTab>> = _tabs.asStateFlow()

    private val _tabsLoading = MutableStateFlow(false)
    val tabsLoading: StateFlow<Boolean> = _tabsLoading.asStateFlow()

    /**
     * The last refusal, shown until it is dismissed or another action succeeds.
     *
     * These are not crashes: "that is already with the kitchen" is a normal
     * answer during service. Kept as the SERVER's wording, because it is more
     * specific than anything phrasable here — it can name how many items are
     * still unsent, and when a line was fired.
     */
    private val _tabMessage = MutableStateFlow<String?>(null)
    val tabMessage: StateFlow<String?> = _tabMessage.asStateFlow()

    /**
     * The tab the cart is currently being built for, or null for an ordinary
     * counter sale.
     *
     * This is what makes the menu and cart do double duty. With a tab selected,
     * "confirm" adds the cart to THAT tab instead of ringing up a new sale — so
     * a server adds a second course through the same screens they take the
     * first order on, rather than a parallel set that has to be kept in step.
     */
    private val _activeTabId = MutableStateFlow<String?>(null)
    val activeTabId: StateFlow<String?> = _activeTabId.asStateFlow()

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

    fun openTabs() {
        _destination.value = PosDestination.TABS
        refreshTabs()
    }

    // --- Open tabs ----------------------------------------------------------

    fun dismissTabMessage() { _tabMessage.value = null }

    fun refreshTabs() {
        viewModelScope.launch {
            _tabsLoading.value = true
            try {
                _tabs.value = repository.openTabs()
            } catch (e: Exception) {
                // Unlike the orders list, say so. A stale tab list is dangerous
                // in a way a stale history is not: a server would fire or settle
                // against lines that are no longer what they see.
                _tabMessage.value = messageFor(e, "تعذّر تحديث الطاولات المفتوحة")
            } finally {
                _tabsLoading.value = false
            }
        }
    }

    /**
     * Turns the cart into a new tab.
     *
     * The cart is cleared only on success — the same rule checkout follows, so a
     * refusal never costs a server the order they just keyed in.
     */
    fun openTabFromCart() {
        val cart = _cartState.value
        viewModelScope.launch {
            try {
                repository.openTab(cart.note.orEmpty(), cart.items)
                clearCart()
                _tabMessage.value = null
                _destination.value = PosDestination.TABS
                refreshTabs()
            } catch (e: Exception) {
                _tabMessage.value = messageFor(e, "تعذّر فتح الطاولة")
                _destination.value = PosDestination.TABS
            }
        }
    }

    /** Picks a tab to add to, then sends the server back to the menu. */
    fun addToTab(tabId: String) {
        _activeTabId.value = tabId
        _destination.value = PosDestination.MENU
    }

    fun cancelAddToTab() {
        _activeTabId.value = null
        _destination.value = PosDestination.TABS
    }

    /** Commits the cart to the tab chosen by [addToTab]. */
    fun confirmAddToTab() {
        val tabId = _activeTabId.value ?: return
        val cart = _cartState.value
        if (cart.items.isEmpty()) return
        viewModelScope.launch {
            try {
                repository.addTabItems(tabId, cart.items)
                clearCart()
                _activeTabId.value = null
                _tabMessage.value = null
            } catch (e: Exception) {
                _tabMessage.value = messageFor(e, "تعذّر إضافة الأصناف")
            }
            _destination.value = PosDestination.TABS
            refreshTabs()
        }
    }

    /**
     * Takes a line off a tab. Refused by the server once the line is fired —
     * the food exists by then, and removing it is a void, not a delete.
     */
    fun removeTabLine(lineId: String) {
        viewModelScope.launch {
            try {
                repository.removeTabLine(lineId)
                _tabMessage.value = null
            } catch (e: Exception) {
                _tabMessage.value = messageFor(e, "تعذّر حذف الصنف")
            }
            refreshTabs()
        }
    }

    /** Sends the unfired lines to the kitchen. This is where stock moves. */
    fun fireTab(tabId: String) {
        viewModelScope.launch {
            try {
                val fired = repository.fireTab(tabId)
                _tabMessage.value = "أُرسل $fired صنف إلى المطبخ"
            } catch (e: Exception) {
                _tabMessage.value = messageFor(e, "تعذّر الإرسال للمطبخ")
            }
            refreshTabs()
        }
    }

    /** Takes the money. Only now does the tab count as revenue. */
    fun settleTab(tabId: String) {
        viewModelScope.launch {
            try {
                val total = repository.settleTab(tabId)
                _tabMessage.value = "تم تحصيل ${"%.2f".format(total)} ج.م"
            } catch (e: Exception) {
                _tabMessage.value = messageFor(e, "تعذّر التحصيل")
            }
            refreshTabs()
        }
    }

    /**
     * The server's own wording where there is one, a plain fallback otherwise.
     *
     * A refusal is deliberately distinguished from a network failure: the first
     * means the request was understood and declined and the server should read
     * it, the second means try again.
     */
    private fun messageFor(e: Exception, fallback: String): String = when (e) {
        is TabRefusedException -> e.message
        is IOException -> "لا يوجد اتصال بالخادم — الطاولات تحتاج اتصالاً"
        else -> fallback
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

    /**
     * Adds one of [item] to the cart.
     *
     * It merges into an existing line ONLY when that line carries no
     * instruction. Once a cashier has written "بدون بصل" on a burger, tapping
     * burger again means another, ordinary burger — not another one without
     * onions — so it starts a new line. Merging on item id alone (which is what
     * this did before notes existed) would have quietly discarded one of the
     * two instructions, and the one that disappears could be the allergy.
     */
    fun addToCart(item: SellableItem) {
        val current = _cartState.value.items
        val plainLine = current.firstOrNull { it.sellableItem.id == item.id && it.note == null }
        val updated = if (plainLine != null) {
            current.map { line ->
                if (line.lineId == plainLine.lineId) line.copy(quantity = line.quantity + 1) else line
            }
        } else {
            current + CartItem(sellableItem = item, quantity = 1)
        }
        _cartState.value = recompute(updated)
    }

    /**
     * Adds one unit to a specific LINE, keeping its instruction.
     *
     * Distinct from [addToCart]: pressing + on "برجر — بدون بصل" means a second
     * burger without onions, whereas tapping the burger on the menu means an
     * ordinary one. Routing both through addToCart would attach the instruction
     * to a dish nobody asked it for, or drop it from one that did.
     */
    fun incrementLine(lineId: String) {
        val updated = _cartState.value.items.map { line ->
            if (line.lineId == lineId) line.copy(quantity = line.quantity + 1) else line
        }
        _cartState.value = recompute(updated)
    }

    /**
     * Removes one unit from a specific LINE; drops the line when it hits zero.
     *
     * Keyed by lineId rather than by item, because two lines can now hold the
     * same dish and decrementing "the burger" would be ambiguous.
     */
    fun decrement(lineId: String) {
        val updated = _cartState.value.items
            .map { line -> if (line.lineId == lineId) line.copy(quantity = line.quantity - 1) else line }
            .filter { it.quantity > 0 }
        _cartState.value = recompute(updated)
    }

    /** Removes one line from the cart regardless of quantity. */
    fun removeLine(lineId: String) {
        val updated = _cartState.value.items.filterNot { it.lineId == lineId }
        _cartState.value = recompute(updated)
    }

    /**
     * Attaches (or clears) the instruction on one line.
     *
     * Blank clears it rather than storing an empty string, so the line becomes
     * mergeable again and the kitchen ticket does not print an empty bullet.
     */
    fun setLineNote(lineId: String, note: String) {
        val clean = note.trim().ifBlank { null }
        val updated = _cartState.value.items.map { line ->
            if (line.lineId == lineId) line.copy(note = clean) else line
        }
        _cartState.value = recompute(updated)
    }

    /** Context for the whole order: table number, takeaway, an allergy warning. */
    fun setOrderNote(note: String) {
        _cartState.value = _cartState.value.copy(note = note.trim().ifBlank { null })
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

    // Carries the order note forward. Building a fresh OrderState here would
    // drop it every time a line changed — so typing "طاولة ٥" and then adding
    // one more drink would silently lose the table number.
    private fun recompute(items: List<CartItem>): OrderState =
        _cartState.value.copy(
            items = items,
            totalAmount = items.sumOf { it.sellableItem.price * it.quantity },
        )
}
