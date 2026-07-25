package com.mosaizmundo.pos.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import com.mosaizmundo.pos.ui.screens.CartScreen
import com.mosaizmundo.pos.ui.screens.CheckoutScreen
import com.mosaizmundo.pos.ui.screens.MenuScreen
import com.mosaizmundo.pos.ui.screens.OrdersScreen
import com.mosaizmundo.pos.ui.viewmodel.PosDestination
import com.mosaizmundo.pos.ui.viewmodel.PosViewModel

/**
 * The authenticated POS flow. A tiny state machine over PosViewModel.destination
 * routes between the menu, the cart, checkout, and recent orders — no navigation
 * library needed for four screens, and the destination survives config changes
 * (it's in the ViewModel). Hardware back mirrors the in-screen back buttons.
 */
@Composable
fun PosApp(viewModel: PosViewModel) {
    val destination by viewModel.destination.collectAsState()
    val cart by viewModel.cartState.collectAsState()
    val checkoutStatus by viewModel.checkoutStatus.collectAsState()

    when (destination) {
        PosDestination.MENU -> {
            MenuScreen(
                viewModel = viewModel,
                onProceed = viewModel::openCart,
                onOpenOrders = viewModel::openOrders,
            )
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
