package com.mosaizmundo.pos.domain

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Opening a tab at a table (0045).
 *
 * The rule these all circle is one the DATABASE owns — one open tab per table,
 * enforced by a partial unique index since 0043. Nothing here re-implements it.
 * What is tested is that the till agrees with it, because a till that offers a
 * table the server will refuse is a till that collects refusals in front of a
 * waiting party.
 *
 * The mock repository is the subject on purpose: it is what the demo build and
 * every screen preview run against, so a mock that behaves more permissively
 * than the server teaches a habit that breaks in service.
 */
class FloorTableTest {

    @Test
    fun `a tab opened at a table carries the table, not a description of it`() = runBlocking {
        val repo = MockPosRepository()
        val tables = repo.tables()
        val free = tables.first { t -> repo.openTabs().none { it.table?.id == t.id } }

        val id = repo.openTab("", emptyList(), free.id)
        val tab = repo.openTabs().first { it.id == id }

        assertEquals(free.id, tab.table?.id)
        assertEquals(free.label, tab.table?.label)
    }

    @Test
    fun `one table, one tab`() = runBlocking {
        val repo = MockPosRepository()
        val free = repo.tables().first { t -> repo.openTabs().none { it.table?.id == t.id } }
        repo.openTab("", emptyList(), free.id)

        try {
            repo.openTab("", emptyList(), free.id)
            fail("a second tab was opened on a table that already had one")
        } catch (e: TabRefusedException) {
            assertEquals(409, e.httpCode)
            // The waiter is holding a tablet in a room with twenty tables.
            assertTrue("the refusal does not name the table: ${e.message}",
                e.message.contains(free.label))
        }
    }

    @Test
    fun `a tab with no table is still a tab`() = runBlocking {
        // Takeaway. Also every restaurant that does not run the reservations
        // module, which has no floor plan to choose from at all.
        val repo = MockPosRepository()

        val id = repo.openTab("تيك أواي", emptyList(), null)
        val tab = repo.openTabs().first { it.id == id }

        assertNull(tab.table)
        assertEquals("تيك أواي", tab.note)
    }

    @Test
    fun `many tabs with no table can run at once`() = runBlocking {
        // The one-tab-per-table rule must not reach takeaway. In the database
        // that is because NULLs are distinct; here it is because the check is
        // skipped when there is no table. Both have to agree.
        val repo = MockPosRepository()

        val a = repo.openTab("تيك أواي ١", emptyList(), null)
        val b = repo.openTab("تيك أواي ٢", emptyList(), null)

        // Counted by id, not by note: the mock already seeds a takeaway tab,
        // and a prefix match would have counted it too — passing for a reason
        // that has nothing to do with opening two.
        val opened = repo.openTabs().filter { it.id == a || it.id == b }
        assertEquals(2, opened.size)
        assertTrue(opened.all { it.table == null })
    }

    /**
     * `busy` is the picker's whole job, and it is derived rather than fetched:
     * the open tabs are already in hand, and asking the server which tables are
     * free would be a second request that is stale by the time it lands.
     */
    private fun mark(tables: List<FloorTable>, tabs: List<OpenTab>): List<FloorTable> {
        val taken = tabs.mapNotNull { it.table?.id }.toSet()
        return tables.map { it.copy(busy = it.id in taken) }
    }

    @Test
    fun `a table running a tab is marked busy, and the others are not`() {
        val tables = listOf(
            FloorTable("t1", "طاولة ١", null, 4),
            FloorTable("t2", "طاولة ٢", null, 2),
        )
        val tabs = listOf(
            OpenTab("o1", null, tables[0], 0.0, "", emptyList()),
        )

        val marked = mark(tables, tabs)

        assertTrue(marked.first { it.id == "t1" }.busy)
        // The other half. Without this, "everything is busy" would pass too.
        assertTrue(!marked.first { it.id == "t2" }.busy)
    }

    @Test
    fun `a takeaway tab makes no table busy`() {
        // A tab with a null table must not mark anything — a naive
        // implementation that maps ids without filtering nulls would put a
        // null in the taken set and, depending on the language, take out the
        // first table or none of them. Here it is simply nobody's table.
        val tables = listOf(FloorTable("t1", "طاولة ١", null, 4))
        val tabs = listOf(OpenTab("o1", "تيك أواي", null, 0.0, "", emptyList()))

        assertTrue(!mark(tables, tabs).first().busy)
    }

    @Test
    fun `settling frees the table for the next party`() = runBlocking {
        // Otherwise a restaurant can seat each table exactly once per shift.
        val repo = MockPosRepository()
        val free = repo.tables().first { t -> repo.openTabs().none { it.table?.id == t.id } }

        val id = repo.openTab("", emptyList(), free.id)
        repo.addTabItems(id, emptyList())
        repo.settleTab(id)

        val stillOpen = repo.openTabs().any { it.table?.id == free.id }
        assertTrue("the table is still held by a settled tab", !stillOpen)
    }
}
