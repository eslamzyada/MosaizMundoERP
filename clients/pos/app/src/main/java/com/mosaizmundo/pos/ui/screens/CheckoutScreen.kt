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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mosaizmundo.pos.domain.OrderState
import com.mosaizmundo.pos.ui.viewmodel.CheckoutStatus
import java.util.Locale

/**
 * Confirms and submits the order. The body switches on [status]: a review +
 * "confirm payment" button (IDLE/ERROR), a spinner (SUBMITTING), or a success
 * panel that starts a new order (SUCCESS). The actual POST is triggered by
 * [onConfirm] -> PosViewModel.checkout().
 */
@Composable
fun CheckoutScreen(
    cart: OrderState,
    status: CheckoutStatus,
    onConfirm: () -> Unit,
    onNewOrder: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
        if (status != CheckoutStatus.SUCCESS) {
            ScreenHeader(title = "الدفع", onBack = onBack)
            Spacer(Modifier.height(16.dp))
        }

        when (status) {
            CheckoutStatus.SUBMITTING -> CenteredState {
                CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(16.dp))
                Text("جارٍ إتمام الدفع…", color = MaterialTheme.colorScheme.onBackground, fontSize = 16.sp)
            }

            CheckoutStatus.SUCCESS -> CenteredState {
                Text("✓", color = MaterialTheme.colorScheme.primary, fontSize = 64.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(12.dp))
                Text("تم الدفع بنجاح", color = MaterialTheme.colorScheme.onBackground, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(24.dp))
                Button(onClick = onNewOrder, modifier = Modifier.fillMaxWidth().height(54.dp)) {
                    Text("طلب جديد", fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
            }

            else -> OrderReview(
                cart = cart,
                isError = status == CheckoutStatus.ERROR,
                onConfirm = onConfirm,
            )
        }
    }
}

@Composable
private fun OrderReview(
    cart: OrderState,
    isError: Boolean,
    onConfirm: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Text(
                    text = "ملخص الطلب",
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(12.dp))
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(cart.items, key = { it.sellableItem.id }) { line ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                text = "${line.sellableItem.nameAr}  × ${line.quantity}",
                                color = MaterialTheme.colorScheme.onSurface,
                                fontSize = 14.sp,
                            )
                            Text(
                                text = "%.2f".format(Locale.US, line.sellableItem.price * line.quantity),
                                color = MaterialTheme.colorScheme.onSurface,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f))
                Spacer(Modifier.height(12.dp))
                // Payment method is a placeholder — cash only until a real
                // tender flow lands.
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("طريقة الدفع", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
                    Text("نقدًا", color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
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

        if (isError) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = "تعذّر إتمام الدفع. تحقّق من الاتصال وحاول مرة أخرى.",
                color = MaterialTheme.colorScheme.error,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.height(16.dp))
        Button(
            onClick = onConfirm,
            enabled = cart.items.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().height(54.dp),
        ) {
            Text(
                text = if (isError) "إعادة المحاولة" else "تأكيد الدفع",
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun CenteredState(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) { content() }
    }
}
