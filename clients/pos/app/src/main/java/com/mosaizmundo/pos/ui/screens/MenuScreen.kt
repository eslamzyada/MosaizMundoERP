package com.mosaizmundo.pos.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mosaizmundo.pos.domain.SellableItem
import com.mosaizmundo.pos.ui.viewmodel.PosViewModel
import java.util.Locale

@Composable
fun MenuScreen(viewModel: PosViewModel, onProceed: () -> Unit) {
    val menu by viewModel.menuState.collectAsState()
    val cart by viewModel.cartState.collectAsState()
    val failedCount by viewModel.failedOrderCount.collectAsState()

    Column(modifier = Modifier.fillMaxSize()) {
        // Alert the cashier when a queued sale was permanently rejected by the
        // server — those orders are held, not lost, and need attention (F-03).
        if (failedCount > 0) {
            FailedSyncBanner(count = failedCount)
        }

        // Under a forced RTL layout direction, the first child sits at the start
        // (the right): the menu (65%), then the cart (35%) on the left. The cart
        // panel's action advances to the dedicated Cart screen (onProceed).
        Row(modifier = Modifier.weight(1f).fillMaxWidth()) {
            MenuGrid(
                items = menu,
                onItemClick = viewModel::addToCart,
                modifier = Modifier.weight(0.65f).fillMaxHeight(),
            )
            CartPanel(
                cart = cart,
                onClear = viewModel::clearCart,
                onCheckout = onProceed,
                modifier = Modifier.weight(0.35f).fillMaxHeight(),
            )
        }
    }
}

@Composable
private fun FailedSyncBanner(count: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(
            text = "⚠️  $count طلب لم تتم مزامنته مع الخادم — يرجى المراجعة",
            color = MaterialTheme.colorScheme.onErrorContainer,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun MenuGrid(
    items: List<SellableItem>,
    onItemClick: (SellableItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.padding(16.dp)) {
        Text(
            text = "القائمة",
            color = MaterialTheme.colorScheme.onBackground,
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(16.dp))
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 168.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            items(items, key = { it.id }) { item ->
                MenuItemCard(item = item, onClick = { onItemClick(item) })
            }
        }
    }
}

@Composable
private fun MenuItemCard(item: SellableItem, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().height(168.dp),
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(text = item.imagePlaceholder, fontSize = 44.sp)
            Text(
                text = item.nameAr,
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                // Latin numerals regardless of device locale.
                text = "%.2f ج.م".format(Locale.US, item.price),
                color = MaterialTheme.colorScheme.primary,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}
