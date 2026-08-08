package com.mosaizmundo.pos.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mosaizmundo.pos.domain.TillCount
import com.mosaizmundo.pos.domain.TillSession
import com.mosaizmundo.pos.ui.viewmodel.PosViewModel

/**
 * The drawer.
 *
 * One screen, one question: does the cash in the drawer match what the system
 * says should be there? Everything on it exists to make the answer honest.
 *
 * THE EXPECTED FIGURE IS NEVER SHOWN WHILE COUNTING. It is on the screen while
 * the drawer is open — a cashier needs to know roughly where they are — but the
 * moment the count is being typed it is deliberately out of sight, because a
 * number in front of somebody counting money is a number they will count
 * towards. A cash-up that agrees because the target was visible has measured
 * nothing, and the whole point is to catch the nights it does NOT agree.
 *
 * The variance is shown afterwards, plainly, in both directions. OVER is not
 * good news dressed in green — it usually means a sale went unrecorded.
 */
@Composable
fun TillScreen(viewModel: PosViewModel, onBack: () -> Unit) {
    val session by viewModel.till.collectAsState()
    val message by viewModel.tillMessage.collectAsState()
    val lastCount by viewModel.lastCount.collectAsState()
    var opening by remember { mutableStateOf(false) }
    var counting by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.refreshTill() }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("الدرج", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            TextButton(onClick = onBack) { Text("رجوع") }
        }

        Spacer(Modifier.height(16.dp))

        message?.let {
            Text(
                text = it,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(bottom = 12.dp),
            )
        }

        val open = session
        if (open == null) {
            ClosedDrawer(
                lastCount = lastCount,
                onOpen = { opening = true },
            )
        } else {
            OpenDrawer(session = open, onCount = { counting = true })
        }
    }

    if (opening) {
        AmountDialog(
            title = "افتح الدرج",
            help = "كم في الدرج الآن قبل البيع؟",
            confirm = "افتح",
            onDismiss = { opening = false },
            onConfirm = { amount ->
                viewModel.openTill(amount)
                opening = false
            },
        )
    }

    if (counting) {
        AmountDialog(
            title = "عُدّ الدرج",
            // No expected figure here, on purpose. See the file comment.
            help = "اكتب المبلغ النقدي الموجود فعلًا في الدرج.",
            confirm = "أغلق الدرج",
            onDismiss = { counting = false },
            onConfirm = { amount ->
                viewModel.closeTill(amount)
                counting = false
            },
        )
    }
}

@Composable
private fun ClosedDrawer(lastCount: TillCount?, onOpen: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = "الدرج مغلق.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        Button(onClick = onOpen, modifier = Modifier.fillMaxWidth()) { Text("افتح الدرج") }

        // The result of the count just done. Shown here rather than in a toast
        // that vanishes: it is the one number somebody may need to write down,
        // photograph, or argue about.
        lastCount?.let { count ->
            Spacer(Modifier.height(24.dp))
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("نتيجة آخر جرد", fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Line("المتوقع", count.expectedCash)
                    Line("المعدود", count.countedCash)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = when {
                            count.balances -> "مضبوط"
                            count.isShort -> "عجز %.2f".format(-count.variance)
                            // NOT good news. A drawer that is over usually
                            // means a sale nobody rang up.
                            else -> "زيادة %.2f".format(count.variance)
                        },
                        fontWeight = FontWeight.Bold,
                        fontSize = 18.sp,
                        color = if (count.balances) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun OpenDrawer(session: TillSession, onCount: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                Line("الافتتاحي", session.openingFloat)
                Line("نقدًا اليوم", session.cashTaken)
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("المتوقع في الدرج", fontWeight = FontWeight.Bold)
                    Text("%.2f".format(session.expectedSoFar), fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(12.dp))
                // Reported, and reported apart. It is real money the restaurant
                // took; it is simply not in this drawer, and folding it in
                // would send somebody hunting for cash that was never here.
                Text(
                    text = "بطاقات وتحويلات (ليست في الدرج): %.2f".format(session.otherTaken),
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = onCount, modifier = Modifier.fillMaxWidth()) { Text("عُدّ وأغلق") }
    }
}

@Composable
private fun Line(label: String, amount: Double) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("%.2f".format(amount))
    }
}

/**
 * Asks for one amount.
 *
 * The confirm button stays disabled until something parseable is typed. There
 * is no "close without counting" path anywhere in this stack — it would report
 * a variance of zero every night and make the whole feature decorative.
 */
@Composable
private fun AmountDialog(
    title: String,
    help: String,
    confirm: String,
    onDismiss: () -> Unit,
    onConfirm: (Double) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    val amount = text.trim().toDoubleOrNull()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                Text(help, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    placeholder = { Text("0.00") },
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { amount?.let(onConfirm) },
                enabled = amount != null && amount >= 0,
            ) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}
