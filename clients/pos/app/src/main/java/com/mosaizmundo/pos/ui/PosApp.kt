package com.mosaizmundo.pos.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import com.mosaizmundo.pos.ui.screens.CartScreen
import com.mosaizmundo.pos.ui.screens.CheckoutScreen
import com.mosaizmundo.pos.ui.screens.MenuScreen
import com.mosaizmundo.pos.ui.screens.OrdersScreen
import com.mosaizmundo.pos.ui.screens.TabsScreen
import com.mosaizmundo.pos.ui.viewmodel.PosDestination
import com.mosaizmundo.pos.ui.viewmodel.PosViewModel

/**
 * The authenticated POS flow. A tiny state machine over PosViewModel.destination
 * routes between the menu, the cart, checkout, and recent orders — no navigation
 * library needed for four screens, and the destination survives config changes
 * (it's in the ViewModel). Hardware back mirrors the in-screen back buttons.
 */
@Composable
fun PosApp(viewModel: PosViewModel, onSignOut: () -> Unit) {
    val destination by viewModel.destination.collectAsState()
    val cart by viewModel.cartState.collectAsState()
    val checkoutStatus by viewModel.checkoutStatus.collectAsState()
    // Non-null while a later course is being added to an existing tab. The menu
    // and cart do double duty in that mode rather than there being a second set
    // of screens to keep in step with these.
    val activeTabId by viewModel.activeTabId.collectAsState()

    when (destination) {
        PosDestination.MENU -> {
            // While adding to a tab, back goes to the tabs list and abandons the
            // addition — not to a counter sale the server never asked for.
            if (activeTabId != null) {
                BackHandler { viewModel.cancelAddToTab() }
            }
            MenuScreen(
                viewModel = viewModel,
                onProceed = viewModel::openCart,
                onOpenOrders = viewModel::openOrders,
                onOpenTabs = viewModel::openTabs,
                onSignOut = onSignOut,
            )
        }

        PosDestination.TABS -> {
            BackHandler { viewModel.backToMenu() }
            TabsScreen(viewModel = viewModel, onBack = viewModel::backToMenu)
        }

        PosDestination.ORDERS -> {
            BackHandler { viewModel.backToMenu() }
            OrdersScreen(viewModel = viewModel, onBack = viewModel::backToMenu)
        }

        PosDestination.CART -> {
            BackHandler { viewModel.backToMenu() }
            CartScreen(
                cart = cart,
                // incrementLine, not addToCart: pressing + on a line that says
                // "بدون بصل" means another one of THAT, whereas tapping the
                // dish on the menu means an ordinary one.
                onIncrement = viewModel::incrementLine,
                onDecrement = viewModel::decrement,
                onRemove = viewModel::removeLine,
                onLineNote = viewModel::setLineNote,
                onOrderNote = viewModel::setOrderNote,
                onClear = viewModel::clearCart,
                onProceed = viewModel::openCheckout,
                onBack = viewModel::backToMenu,
                onOpenTab = viewModel::openTabFromCart,
                addingToTab = activeTabId != null,
                onConfirmAddToTab = viewModel::confirmAddToTab,
            )
        }

        PosDestination.CHECKOUT -> {
            BackHandler {
                viewModel.resetCheckoutStatus()
                viewModel.backToCart()
            }
            CheckoutScreen(
                cart = cart,
                status = checkoutStatus,
                onConfirm = viewModel::checkout,
                onNewOrder = {
                    viewModel.resetCheckoutStatus()
                    viewModel.backToMenu()
                },
                onBack = {
                    viewModel.resetCheckoutStatus()
                    viewModel.backToCart()
                },
            )
        }
    }
}
