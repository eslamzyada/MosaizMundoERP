package com.mosaizmundo.pos.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.mosaizmundo.pos.domain.FloorTable
import com.mosaizmundo.pos.domain.OpenTab
import com.mosaizmundo.pos.domain.OpenTabLine
import com.mosaizmundo.pos.domain.PaymentMethod
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
    val floorTables by viewModel.floorTables.collectAsState()
    /** The tab whose payment is being asked about. */
    var settling by remember { mutableStateOf<OpenTab?>(null) }
    var newTableOpen by remember { mutableStateOf(false) }

    // The floor plan is fetched when the screen opens rather than held in the
    // session: a table a manager adds mid-service should appear on the next
    // visit without anybody signing out.
    LaunchedEffect(Unit) { viewModel.refreshTables() }

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
                // Seating a table is the FIRST thing that happens to it, so it
                // belongs here rather than behind a cart that has to be filled
                // before it can be reached.
                Button(onClick = { newTableOpen = true }) { Text("طاولة جديدة") }
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
                text = "لا توجد طاولات مفتوحة. اضغط «طاولة جديدة» لفتح واحدة.",
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
                        onSettle = { settling = tab },
                    )
                }
            }
        }
    }

    settling?.let { tab ->
        HowWasItPaidDialog(
            tab = tab,
            onDismiss = { settling = null },
            onPaid = { method ->
                viewModel.settleTab(tab.id, method)
                settling = null
            },
        )
    }

    if (newTableOpen) {
        NewTableDialog(
            tables = floorTables,
            onDismiss = { newTableOpen = false },
            onConfirm = { note, tableId ->
                viewModel.openEmptyTab(note, tableId)
                newTableOpen = false
            },
        )
    }
}

/**
 * Asks what to call the table.
 *
 * The description is OPTIONAL — a tab with no note is still a real tab, and
 * refusing to open one until something is typed would stand between a server
 * and a table that is already sitting down. It is strongly encouraged, though,
 * because the note is the only thing that identifies a tab in the list.
 */
@Composable
private fun NewTableDialog(
    tables: List<FloorTable>,
    onDismiss: () -> Unit,
    onConfirm: (String, String?) -> Unit,
) {
    var note by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("طاولة جديدة") },
        text = {
            Column {
                if (tables.isEmpty()) {
                    // No floor plan: this is exactly the dialog it always was,
                    // which for a takeaway counter is the right one.
                    Text(
                        text = "اكتب رقم الطاولة أو وصفها — هو ما سيميّزها في القائمة.",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text(
                        text = "اختر الطاولة",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    LazyColumn(modifier = Modifier.heightIn(max = 220.dp)) {
                        items(tables, key = { it.id }) { table ->
                            TableChoice(
                                table = table,
                                selected = chosen == table.id,
                                onSelect = { chosen = if (chosen == table.id) null else table.id },
                            )
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    singleLine = true,
                    label = {
                        Text(
                            if (tables.isEmpty()) {
                                "الوصف"
                            } else {
                                "ملاحظة (اختياري)"
                            },
                        )
                    },
                    placeholder = {
                        Text(
                            if (tables.isEmpty()) {
                                "طاولة ٥"
                            } else {
                                "حساسية مكسرات"
                            },
                        )
                    },
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(note, chosen) },
                // With a floor plan the table IS the point, so it is required.
                // Without one the dialog is the old dialog and the note stays
                // optional, because a party already sitting down should never
                // be waiting on a form.
                enabled = tables.isEmpty() || chosen != null,
            ) { Text("افتح") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}

/**
 * One table in the picker.
 *
 * A table already running a tab is shown and NOT selectable, rather than
 * hidden. "Where did طاولة ٣ go?" is answered better by a greyed row saying it
 * has a tab than by an absence — the same reasoning the modules screen uses
 * for a capability somebody cannot switch.
 */
@Composable
private fun TableChoice(table: FloorTable, selected: Boolean, onSelect: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !table.busy, onClick = onSelect)
            .padding(vertical = 10.dp, horizontal = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = table.label,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (table.busy) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
            val detail = listOfNotNull(
                table.area,
                table.seats?.let { seats -> "$seats مقاعد" },
            ).joinToString(" · ")
            if (detail.isNotBlank()) {
                Text(
                    text = detail,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (table.busy) {
            Text(
                text = "عليها حساب",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (selected) {
            Text(text = "✓", color = MaterialTheme.colorScheme.primary)
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
                    text = tab.table?.label ?: tab.note ?: "طاولة بدون وصف",
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

/**
 * How was it paid?
 *
 * Asked at the till, once, because this is the only moment anybody knows the
 * answer. A minute later the card machine has moved on and the cash is in the
 * drawer with everything else.
 *
 * "دون تحديد" is offered and is deliberately NOT the prominent choice. A till
 * must never stand between a queue and a closed bill, so the escape exists —
 * but a night of unspecified sales reconciles against nothing, and the button
 * that produces one should not be the easiest to press.
 */
@Composable
private fun HowWasItPaidDialog(
    tab: OpenTab,
    onDismiss: () -> Unit,
    onPaid: (PaymentMethod?) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("كيف تم الدفع؟") },
        text = {
            Column {
                Text(
                    text = "الحساب: %.2f ج.م".format(tab.totalAmount),
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(12.dp))
                for (method in PaymentMethod.entries) {
                    TextButton(
                        onClick = { onPaid(method) },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(method.label) }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onPaid(null) }) { Text("دون تحديد") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } },
    )
}
