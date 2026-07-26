package com.mosaizmundo.pos.ui.viewmodel

import com.mosaizmundo.pos.domain.CartItem
import com.mosaizmundo.pos.domain.ConfiguredPrinter
import com.mosaizmundo.pos.domain.OpenTab
import com.mosaizmundo.pos.domain.OrderState
import com.mosaizmundo.pos.domain.PosOrder
import com.mosaizmundo.pos.domain.PosRepository
import com.mosaizmundo.pos.domain.SellableItem
import com.mosaizmundo.pos.domain.VoidReason
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

/**
 * Why the menu is not on screen.
 *
 * This exists because the first version of this code swallowed every exception
 * and left the grid empty. A till showing no food is the most alarming thing
 * the app can do, and a dead backend, an expired session and a restaurant with
 * no dishes entered all produced the identical blank screen — with nothing to
 * press. The distinctions asserted below are the whole point of the fix, and
 * none of them are visible from a screenshot.
 */
class MenuStateTest {

    private val dispatcher = UnconfinedTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    /** Answers getMenu() with whatever the test asks for. */
    private class FakeRepository(
        private val menu: () -> List<SellableItem> = { emptyList() },
    ) : PosRepository {
        var openedNote: String? = null
        var openedItems: List<CartItem>? = null

        override suspend fun getMenu(): List<SellableItem> = menu()
        override suspend fun submitOrder(orderState: OrderState) = Unit
        override suspend fun recentOrders(): List<PosOrder> = emptyList()
        override suspend fun voidOrder(
            orderId: String,
            restoreStock: Boolean,
            reason: VoidReason,
            note: String,
            managerToken: String?,
        ) = Unit

        override suspend fun openTabs(): List<OpenTab> = emptyList()
        override suspend fun openTab(note: String, items: List<CartItem>): String {
            openedNote = note
            openedItems = items
            return "t-1"
        }
        override suspend fun addTabItems(orderId: String, items: List<CartItem>) = Unit
        override suspend fun removeTabLine(lineId: String) = Unit
        override suspend fun fireTab(orderId: String): Int = 0
        override suspend fun settleTab(orderId: String): Double = 0.0
        override suspend fun printers(): List<ConfiguredPrinter> = emptyList()
        override fun failedOrderCount(): Flow<Int> = flowOf(0)
    }

    private fun http(code: Int) = HttpException(
        Response.error<Unit>(code, "".toResponseBody("application/json".toMediaType())),
    )

    private fun viewModel(repository: PosRepository) = PosViewModel(repository)

    @Test
    fun `a loaded menu carries its items`() = runTest {
        val item = SellableItem("s1", "كشري", 45.0, "🍽️", portionsAvailable = null)
        val state = viewModel(FakeRepository { listOf(item) }).menuState.value

        assertTrue(state is MenuState.Loaded)
        assertEquals(listOf(item), (state as MenuState.Loaded).items)
    }

    @Test
    fun `an empty catalogue is Empty, NOT a failure`() {
        // A restaurant that has entered no dishes is not broken, and telling
        // them the server is unreachable would send them chasing the network.
        val state = viewModel(FakeRepository { emptyList() }).menuState.value
        assertEquals(MenuState.Empty, state)
    }

    @Test
    fun `an unreachable server says so, and offers a retry`() {
        val state = viewModel(FakeRepository { throw IOException("no route") }).menuState.value

        assertTrue(state is MenuState.Failed)
        state as MenuState.Failed
        // The network may come back on its own, so retry is the right offer.
        assertTrue("a connection failure must be retryable", state.canRetry)
        assertTrue(state.message.contains("الشبكة"))
    }

    @Test
    fun `an expired session does NOT offer a retry`() {
        // Retrying a 401 fails again every time. Offering the button teaches a
        // server that it does nothing, which is worse than not having it.
        val state = viewModel(FakeRepository { throw http(401) }).menuState.value

        assertTrue(state is MenuState.Failed)
        state as MenuState.Failed
        assertTrue("retry cannot fix an expired session", !state.canRetry)
        assertTrue("it must say to sign in again", state.message.contains("الجلسة"))
    }

    @Test
    fun `a forbidden role does NOT offer a retry either`() {
        val state = viewModel(FakeRepository { throw http(403) }).menuState.value
        assertTrue(state is MenuState.Failed)
        assertTrue(!(state as MenuState.Failed).canRetry)
    }

    @Test
    fun `a server error is retryable and names the code`() {
        val state = viewModel(FakeRepository { throw http(500) }).menuState.value
        assertTrue(state is MenuState.Failed)
        state as MenuState.Failed
        assertTrue(state.canRetry)
        assertTrue(state.message.contains("500"))
    }

    @Test
    fun `the menu can be loaded again after a failure`() {
        // The original bug was not only silence: the menu loaded ONCE, in init,
        // so a till started while the network was down stayed blank until the
        // app was killed. Nobody should be asked to do that mid-shift.
        var fail = true
        val repository = FakeRepository {
            if (fail) throw IOException("down") else listOf(
                SellableItem("s1", "كشري", 45.0, "🍽️", portionsAvailable = null),
            )
        }
        val vm = viewModel(repository)
        assertTrue(vm.menuState.value is MenuState.Failed)

        fail = false
        vm.loadMenu()

        assertTrue("a retry must be able to succeed", vm.menuState.value is MenuState.Loaded)
    }

    @Test
    fun `a table can be opened with NO items, even when the cart is not empty`() {
        // The only route to opening a tab used to be the cart screen, which
        // cannot be reached with an empty cart — so a table could not be seated
        // before it ordered, which is how every table starts.
        //
        // The cart is deliberately LOADED here. A server part-way through a
        // counter sale who seats a new table must not have that half-built
        // order land on it; asserting against an already-empty cart would pass
        // whether or not the cart was being sent, which is exactly what an
        // earlier version of this test did.
        val repository = FakeRepository()
        val vm = viewModel(repository)
        vm.addToCart(SellableItem("s1", "كشري", 45.0, "🍽️", portionsAvailable = null))
        vm.addToCart(SellableItem("s2", "كولا", 15.0, "🍽️", portionsAvailable = null))
        assertEquals(2, vm.cartState.value.items.size)

        vm.openEmptyTab("طاولة ٥")

        assertEquals("طاولة ٥", repository.openedNote)
        assertEquals(
            "a new table must open EMPTY, not carrying whatever was in the cart",
            emptyList<CartItem>(),
            repository.openedItems,
        )
        // And the cart is left alone: the counter sale is still being built.
        assertEquals(2, vm.cartState.value.items.size)
    }

    @Test
    fun `a table with no description is still allowed`() {
        // Refusing to open one until something is typed would stand between a
        // server and a table that is already sitting down.
        val repository = FakeRepository()
        viewModel(repository).openEmptyTab("")

        assertEquals("", repository.openedNote)
        assertEquals(emptyList<CartItem>(), repository.openedItems)
    }
}
