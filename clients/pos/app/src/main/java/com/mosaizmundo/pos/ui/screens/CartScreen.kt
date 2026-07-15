package com.mosaizmundo.pos.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mosaizmundo.pos.domain.CartItem
import com.mosaizmundo.pos.domain.OrderState
import com.mosaizmundo.pos.domain.SellableItem
import java.util.Locale

/**
 * Full-screen cart: review lines, adjust quantities (+/-), remove lines, and
 * proceed to checkout. Purely a view over PosViewModel state — all mutations go
 * back through the passed lambdas.
 */
@Composable
fun CartScreen(
    cart: OrderState,
    onIncrement: (SellableItem) -> Unit,
    onDecrement: (SellableItem) -> Unit,
    onRemove: (SellableItem) -> Unit,
    onClear: () -> Unit,
    onProceed: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
        ScreenHeader(
            title = "السلة",
            onBack = onBack,
            trailing = {
                if (cart.items.isNotEmpty()) {
                    TextButton(onClick = onClear) {
                        Text("إفراغ", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            },
        )
        Spacer(Modifier.height(12.dp))

        if (cart.items.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    text = "السلة فارغة",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 16.sp,
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(cart.items, key = { it.sellableItem.id }) { line ->
                    CartLineCard(
                        line = line,
                        onIncrement = { onIncrement(line.sellableItem) },
                        onDecrement = { onDecrement(line.sellableItem) },
                        onRemove = { onRemove(line.sellableItem) },
                    )
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f))
        Spacer(Modifier.height(12.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = "الإجمالي",
                color = MaterialTheme.colorScheme.onBackground,
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "%.2f ج.م".format(Locale.US, cart.totalAmount),
                color = MaterialTheme.colorScheme.primary,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = onProceed,
            enabled = cart.items.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().height(54.dp),
        ) {
            Text("المتابعة إلى الدفع", fontSize = 16.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun CartLineCard(
    line: CartItem,
    onIncrement: () -> Unit,
    onDecrement: () -> Unit,
    onRemove: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = line.sellableItem.nameAr,
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "%.2f ج.م".format(Locale.US, line.sellableItem.price),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 13.sp,
                )
            }

            QuantityStepper(
                quantity = line.quantity,
                onIncrement = onIncrement,
                onDecrement = onDecrement,
            )

            Spacer(Modifier.size(12.dp))
            Text(
                text = "%.2f".format(Locale.US, line.sellableItem.price * line.quantity),
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
            )
            TextButton(onClick = onRemove) {
                Text("حذف", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun QuantityStepper(
    quantity: Int,
    onIncrement: () -> Unit,
    onDecrement: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(
            onClick = onDecrement,
            modifier = Modifier.size(40.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
        ) {
            Text("−", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Text(
            text = quantity.toString(),
            color = MaterialTheme.colorScheme.onSurface,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 12.dp),
        )
        OutlinedButton(
            onClick = onIncrement,
            modifier = Modifier.size(40.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
        ) {
            Text("+", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
    }
}

/** Simple back-header used by the Cart and Checkout screens (no experimental TopAppBar). */
@Composable
fun ScreenHeader(
    title: String,
    onBack: () -> Unit,
    trailing: @Composable () -> Unit = {},
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) {
                Text("رجوع ›", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp)
            }
            Spacer(Modifier.size(4.dp))
            Text(
                text = title,
                color = MaterialTheme.colorScheme.onBackground,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        trailing()
    }
}
