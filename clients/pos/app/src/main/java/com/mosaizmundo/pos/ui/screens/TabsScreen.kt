package com.mosaizmundo.pos.ui.screens

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mosaizmundo.pos.domain.OpenTab
import com.mosaizmundo.pos.domain.OpenTabLine
import com.mosaizmundo.pos.ui.viewmodel.PosViewModel
import java.util.Locale

/**
 * The tables currently eating.
 *
 * Restaurant service is not a counter queue: a table orders drinks, then
 * starters, then more bread, and pays once at the end. Until open tabs existed
 * the till could only ring a finished sale, so "edit the order in the queue" had
 * nothing to edit — a server either held the order in their head or rang up four
 * separate sales for one table.
 *
 * TWO THINGS ARE DELIBERATELY DISTINCT ON THIS SCREEN, because they are
 * different events with different consequences:
 *
 *   SEND TO KITCHEN (fire)  the food starts being made. The ingredients leave
 *                           the shelf at this moment, and the line's cost is
 *                           captured. It can be done more than once as later
 *                           courses are added.
 *
 *   SETTLE                  the money is taken and the tab becomes a sale. Only
 *                           now does it appear in any revenue figure.
 *
 * A line that has been sent is shown but cannot be deleted here: the food
 * exists, so taking it off the bill is a void — which asks whether it was made
 * and what to do about the stock — not a delete.
 */
@Composable
fun TabsScreen(
    viewModel: PosViewModel,
    onBack: () -> Unit,
) {
    val tabs by viewModel.tabs.collectAsState()
    val loading by viewModel.tabsLoading.collectAsState()
    val message by viewModel.tabMessage.collectAsState()
    val printWarning by viewModel.printWarning.collectAsState()

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "الطاولات المفتوحة",
                color = MaterialTheme.colorScheme.onBackground,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = viewModel::refreshTabs) { Text("تحديث") }
                OutlinedButton(onClick = onBack) { Text("رجوع") }
            }
        }

        Spacer(Modifier.height(12.dp))

        // A ticket the kitchen never got. Kept ABOVE the ordinary message and
        // styled as an error, because the food is being cooked and nothing on
        // paper says so — somebody has to walk to the kitchen. It is not
        // cleared by the next successful action; dismissing it is deliberate.
        printWarning?.let { text ->
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                ),
            ) {
                Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                    Text(
                        text = text,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = "الطلب أُرسل للمطبخ فعليًا — التذكرة وحدها لم تُطبع.",
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        fontSize = 12.sp,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = viewModel::reprintKitchenTicket) {
                            Text("إعادة الطباعة")
                        }
                        TextButton(onClick = viewModel::dismissPrintWarning) { Text("إخفاء") }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        }

        // The server's own words, kept until dismissed. A refusal mid-service is
        // information ("3 items have not been sent yet"), not an error to hide.
        message?.let { text ->
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = text,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 14.sp,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = viewModel::dismissTabMessage) { Text("إخفاء") }
                }
            }
            Spacer(Modifier.height(12.dp))
        }

        when {
            loading && tabs.isEmpty() -> Text(
                text = "جارٍ التحميل…",
                color = MaterialTheme.colorScheme.onBackground,
                fontSize = 16.sp,
            )

            tabs.isEmpty() -> Text(
                text = "لا توجد طاولات مفتوحة. افتح طاولة من سلة الطلب.",
                color = MaterialTheme.colorScheme.onBackground,
                fontSize = 16.sp,
            )

            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(tabs, key = { it.id }) { tab ->
                    TabCard(
                        tab = tab,
                        onAddItems = { viewModel.addToTab(tab.id) },
                        onRemoveLine = viewModel::removeTabLine,
                        onFire = { viewModel.fireTab(tab.id) },
                        onSettle = { viewModel.settleTab(tab.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun TabCard(
    tab: OpenTab,
    onAddItems: () -> Unit,
    onRemoveLine: (String) -> Unit,
    onFire: () -> Unit,
    onSettle: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    // The tab's note is how a server recognises the table. With
                    // no note there is nothing but an id, so say so plainly
                    // rather than showing a uuid nobody can match to a table.
                    text = tab.note ?: "طاولة بدون وصف",
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "${format(tab.totalAmount)} ج.م",
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                )
            }

            if (tab.hasUnfired) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${tab.unfiredCount} صنف لم يُرسل للمطبخ",
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            Spacer(Modifier.height(12.dp))

            tab.lines.forEach { line ->
                TabLineRow(line = line, onRemove = { onRemoveLine(line.id) })
            }

            Spacer(Modifier.height(12.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onAddItems) { Text("إضافة أصناف") }

                // Offered only when there is something to send. The server would
                // refuse an empty fire anyway; not offering it is the difference
                // between a button that does nothing and one that is not there.
                if (tab.hasUnfired) {
                    Button(onClick = onFire) { Text("أرسل للمطبخ") }
                }

                Button(
                    onClick = onSettle,
                    // Settling with something unsent is refused by the server:
                    // those items were never cooked, so it would either charge
                    // for food that does not exist or drop it from the bill.
                    enabled = !tab.hasUnfired && tab.lines.isNotEmpty(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                    ),
                ) { Text("تحصيل") }
            }
        }
    }
}

@Composable
private fun TabLineRow(line: OpenTabLine, onRemove: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "${line.name} ×${line.quantity}",
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 15.sp,
            )
            line.note?.let { note ->
                Text(
                    text = note,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 12.sp,
                )
            }
            Text(
                // The only state that matters to a server deciding what they can
                // still change about this table.
                text = if (line.isFired) "في المطبخ" else "لم يُرسل",
                color = if (line.isFired) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.error
                },
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }

        Text(
            text = format(line.lineTotal),
            color = MaterialTheme.colorScheme.onSurface,
            fontSize = 15.sp,
        )

        // A fired line has no delete button at all. Showing one that always
        // fails would train a server to expect a refusal and stop reading it.
        if (!line.isFired) {
            TextButton(onClick = onRemove) { Text("حذف") }
        }
    }
}

private fun format(value: Double): String = String.format(Locale.US, "%.2f", value)
