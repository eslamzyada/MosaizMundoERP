package com.mosaizmundo.pos.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mosaizmundo.pos.domain.PosOrder
import com.mosaizmundo.pos.domain.VoidReason
import com.mosaizmundo.pos.ui.viewmodel.PosViewModel
import com.mosaizmundo.pos.ui.viewmodel.VoidState
import java.util.Locale

/**
 * Recent orders, so a mistake can be corrected where it was made.
 *
 * Before this, a cashier who rang up the wrong thing had to find a manager and
 * a laptop; the money stayed wrong until someone reached the office.
 */
@Composable
fun OrdersScreen(viewModel: PosViewModel, onBack: () -> Unit) {
    val orders by viewModel.orders.collectAsState()
    val loading by viewModel.ordersLoading.collectAsState()
    val voidState by viewModel.voidState.collectAsState()

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "الطلبات الأخيرة",
                color = MaterialTheme.colorScheme.onBackground,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
            )
            OutlinedButton(onClick = onBack) { Text("رجوع") }
        }

        Spacer(Modifier.height(16.dp))

        if (voidState is VoidState.Failed) {
            Text(
                text = (voidState as VoidState.Failed).message,
                color = MaterialTheme.colorScheme.error,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(bottom = 12.dp),
            )
        }

        when {
            loading && orders.isEmpty() ->
                Text("جارٍ التحميل…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            orders.isEmpty() ->
                Text("لا توجد طلبات بعد.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(orders, key = { it.id }) { order ->
                    OrderRow(order = order, onVoid = { viewModel.beginVoid(order) })
                }
            }
        }
    }

    when (val state = voidState) {
        is VoidState.AskingReason -> ReasonDialog(
            order = state.order,
            onChoose = viewModel::chooseReason,
            onDismiss = viewModel::cancelVoid,
        )
        is VoidState.AskingStockChoice -> StockChoiceDialog(
            order = state.order,
            reason = state.reason,
            onChoose = viewModel::chooseStockHandling,
            onDismiss = viewModel::cancelVoid,
        )
        is VoidState.NeedsAuthorisation -> ManagerAuthDialog(
            state = state,
            onAuthorise = viewModel::authoriseVoid,
            onDismiss = viewModel::cancelVoid,
        )
        else -> Unit
    }
}

/**
 * Why is this being voided?
 *
 * Asked first, because it is what the cashier already knows — they are voiding
 * *because* of something. A fixed list rather than a text box: "wrong order",
 * "mistake" and "خطأ" are one event spelled three ways, and a void nobody can
 * total is a void nobody learns from.
 */
@Composable
private fun ReasonDialog(
    order: PosOrder,
    onChoose: (VoidReason, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var selected by remember { mutableStateOf<VoidReason?>(null) }
    var note by remember { mutableStateOf("") }

    val chosen = selected
    val ready = chosen != null && (!chosen.requiresNote || note.isNotBlank())

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("ما سبب الإلغاء؟") },
        text = {
            // Seven options plus a note can exceed a short till screen, so the
            // body scrolls rather than clipping the last choices out of reach.
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text(order.lineSummary, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Spacer(Modifier.height(10.dp))

                VoidReason.values().forEach { reason ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { selected = reason }
                            .padding(vertical = 4.dp),
                    ) {
                        RadioButton(selected = selected == reason, onClick = { selected = reason })
                        Column(modifier = Modifier.padding(start = 4.dp)) {
                            Text(reason.label, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            Text(
                                text = reason.hint,
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                if (chosen != null) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = note,
                        onValueChange = {
                            if (it.length <= VoidReason.NOTE_MAX_LENGTH) note = it
                        },
                        label = {
                            Text(if (chosen.requiresNote) "وضِّح السبب (مطلوب)" else "ملاحظة (اختياري)")
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (chosen.requiresNote && note.isBlank()) {
                        Text(
                            text = "«سبب آخر» بلا توضيح لا يفيد أحدًا لاحقًا.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { if (chosen != null) onChoose(chosen, note) },
                enabled = ready,
            ) { Text("التالي") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("تراجع") }
        },
    )
}

@Composable
private fun OrderRow(order: PosOrder, onVoid: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    // The line summary is what identifies an order — two can
                    // easily share a total.
                    text = order.lineSummary.ifBlank { "طلب" },
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "%.2f ج.م".format(Locale.US, order.totalAmount),
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                )
            }

            if (order.isVoided) {
                // Say so plainly, or a cashier will try to void it again — and
                // say why, so the history is reviewable rather than a column of
                // identical red labels.
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "ملغى",
                        color = MaterialTheme.colorScheme.error,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    if (order.voidReasonLabel.isNotEmpty()) {
                        Text(
                            text = order.voidReasonLabel,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 12.sp,
                        )
                    }
                }
            } else {
                OutlinedButton(onClick = onVoid) { Text("إلغاء") }
            }
        }
    }
}

/**
 * The same question the admin asks, because it is the same decision: restoring
 * stock is right for a mis-tap caught before cooking and wrong for a remake, and
 * only the person standing there knows which happened.
 *
 * [reason] is shown, never used to preselect an answer. A kitchen error caught
 * at the pass restores stock; a cancellation after plating does not. Guessing
 * from the cause would be wrong often enough to corrupt inventory.
 */
@Composable
private fun StockChoiceDialog(
    order: PosOrder,
    reason: VoidReason,
    onChoose: (Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("هل تم تحضير الطعام؟") },
        text = {
            Column {
                Text(order.lineSummary, fontWeight = FontWeight.SemiBold)
                Text(
                    text = "السبب: ${reason.label}",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "الإجابة تحدّد ما يحدث للمكوّنات المخصومة، ولا يمكن تعديلها لاحقًا.",
                    fontSize = 13.sp,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onChoose(true) }) { Text("لم يُحضَّر — أعد المكوّنات") }
        },
        dismissButton = {
            TextButton(onClick = { onChoose(false) }) { Text("حُضِّر بالفعل") }
        },
    )
}

/**
 * Manager authorisation for one action.
 *
 * The terminal stays signed in as the cashier throughout: these credentials
 * authorise this single void and are never stored, so a manager does not have
 * to take over the shift session to correct a mistake.
 */
@Composable
private fun ManagerAuthDialog(
    state: VoidState.NeedsAuthorisation,
    onAuthorise: (String, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("تأكيد المدير") },
        text = {
            Column {
                Text(
                    "إلغاء الطلب يحتاج صلاحية مدير. سجّل دخول المدير لاعتماد هذا الإجراء فقط — " +
                        "لن يتم تغيير جلسة الكاشير.",
                    fontSize = 13.sp,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("البريد الإلكتروني") },
                    singleLine = true,
                    enabled = !state.checking,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("كلمة المرور") },
                    singleLine = true,
                    enabled = !state.checking,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                // Bound to a local so the null check is an unambiguous smart
                // cast, rather than relying on one through a class property.
                val error = state.error
                if (error != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = error,
                        color = MaterialTheme.colorScheme.error,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onAuthorise(email, password) },
                enabled = !state.checking && email.isNotBlank() && password.isNotBlank(),
            ) {
                Text(if (state.checking) "جارٍ التحقّق…" else "اعتماد الإلغاء")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !state.checking) { Text("تراجع") }
        },
    )
}
