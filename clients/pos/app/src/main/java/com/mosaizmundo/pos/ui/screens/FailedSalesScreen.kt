package com.mosaizmundo.pos.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mosaizmundo.pos.domain.FailedSale

/**
 * The sales the server refused, and what to do about them.
 *
 * Before this screen the app said "⚠️ 3 طلب لم تتم مزامنته — يرجى المراجعة" and
 * offered nothing to review with. Each of those rows is money a customer has
 * already handed over; the only thing the till would say about one was that it
 * existed.
 *
 * What a cashier needs in front of them, in this order: how much, what it was,
 * and a way to try again once whatever caused the refusal has been fixed —
 * a re-promoted account, a dish put back on the menu.
 */
@Composable
fun FailedSalesScreen(
    sales: List<FailedSale>,
    onRetry: (String) -> Unit,
    onBack: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().padding(20.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "مبيعات لم تصل إلى الخادم",
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            TextButton(onClick = onBack) { Text("رجوع") }
        }

        if (sales.isEmpty()) {
            // Reached by finishing the last one, so it reads as a result.
            Column(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "لا توجد مبيعات معلّقة. كل شيء وصل إلى الخادم.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            return@Column
        }

        Text(
            text = "هذه المبيعات محفوظة على الجهاز ولم يقبلها الخادم. لم تُفقد. " +
                "بعد معالجة السبب — مثل إعادة صلاحية الحساب أو إعادة صنف محذوف — " +
                "أعد المحاولة.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
        )

        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(sales, key = { it.clientOfflineId }) { sale ->
                FailedSaleCard(sale = sale, onRetry = { onRetry(sale.clientOfflineId) })
            }
        }
    }
}

@Composable
private fun FailedSaleCard(sale: FailedSale, onRetry: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                if (sale.isUnreadable) {
                    // Shown, not hidden. A sale nobody can describe is more
                    // alarming than one they can — and hiding it would leave
                    // the list disagreeing with the count on the banner.
                    Text(
                        text = "طلب غير مقروء",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Text(
                        text = "تعذّرت قراءة تفاصيل هذا الطلب. أبلغ الإدارة بالرقم أدناه.",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text(
                        text = "${"%.2f".format(sale.totalAmount)} ج.م",
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = "${sale.itemCount} صنف",
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                sale.note?.let {
                    Text(
                        text = it,
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // Why it was refused, phrased as who can fix it. This is the
                // difference between a list of stranded sales and a list of
                // things somebody can act on.
                Text(
                    text = sale.reason.message,
                    fontSize = 13.sp,
                    color = if (sale.reason.retryLikelyToHelp) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                    modifier = Modifier.padding(top = 6.dp),
                )

                if (sale.hasTakenAt) {
                    Text(
                        text = "وقت البيع: " + formatTakenAt(sale.queuedAt),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // The idempotency key, which is also the reference somebody
                // will read down a phone line. LTR so it is not reordered by
                // the surrounding Arabic.
                Text(
                    text = sale.clientOfflineId,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Offered on every row, including the ones where something has to
            // change first: a retry costs one idempotent request, and being
            // wrong about whether it will help must never strand a sale. The
            // MESSAGE says whether it is worth pressing yet; the button does
            // not refuse to be pressed.
            Button(onClick = onRetry) { Text("إعادة المحاولة") }
        }
    }
}

/**
 * The time of sale, for somebody standing at a till.
 *
 * Date and time, because a queue can hold both this evening's sales and one
 * that has been stuck since Tuesday, and "21:40" alone cannot tell them apart.
 */
private fun formatTakenAt(epochMillis: Long): String =
    java.text.SimpleDateFormat("yyyy/MM/dd HH:mm", java.util.Locale.getDefault())
        .format(java.util.Date(epochMillis))
