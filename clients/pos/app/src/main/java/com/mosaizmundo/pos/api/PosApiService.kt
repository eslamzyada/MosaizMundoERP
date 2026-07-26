package com.mosaizmundo.pos.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

interface PosApiService {
    /**
     * Who the caller is. [authorization] is nullable and has NO Kotlin default:
     * Retrofit builds a dynamic proxy, and default parameter values on the
     * interface do not survive that reliably. Pass null for the stored session
     * (the interceptor fills it in), or an explicit token to ask who a
     * different set of credentials belongs to.
     */
    @GET("api/me")
    suspend fun getMe(@Header("Authorization") authorization: String?): UserMetadata

    // The POS catalog. /api/pos/menu carries what a till needs — name, price,
    // and how many portions the stock on hand still allows. The POS used to read
    // /api/recipes, which also returns food costs the till has no business
    // holding on a device that leaves the office.
    @GET("api/pos/menu")
    suspend fun getMenu(): List<MenuItemResponse>

    @POST("api/pos/checkout")
    suspend fun checkout(@Body payload: CheckoutPayload): Response<Unit>

    // Recent orders, so a mistake can be found and corrected at the till.
    @GET("api/pos/orders")
    suspend fun getOrders(): List<OrderResponse>

    /**
     * Voids an order.
     *
     * [authorization] is null when the signed-in user may void themselves — the
     * interceptor then supplies the stored session. On a till signed in as a
     * cashier it carries a manager's token for this one call, which
     * PosApiProvider leaves alone and the app never persists.
     */
    @POST("api/pos/orders/{id}/void")
    suspend fun voidOrder(
        @Path("id") orderId: String,
        @Header("Authorization") authorization: String?,
        @Body payload: VoidOrderPayload,
    ): Response<Unit>

    // ---- Open tabs (0029) ---------------------------------------------------
    //
    // Every call below returns Response<T> rather than a bare T. The refusals
    // here are ROUTINE and each means something different to the person at the
    // till — 409 "that is already with the kitchen", 409 "something has not been
    // sent yet", 403 "not your role", 404 "that tab is gone". Unwrapping them
    // into a thrown HttpException at the Retrofit layer would flatten all four
    // into one failure the UI could only report as "something went wrong".

    @GET("api/pos/orders/open")
    suspend fun getOpenTabs(): List<OrderResponse>

    @POST("api/pos/orders/open")
    suspend fun openTab(@Body payload: OpenOrderPayload): Response<OpenOrderResult>

    @POST("api/pos/orders/{id}/items")
    suspend fun addTabItems(
        @Path("id") orderId: String,
        @Body payload: AddItemsPayload,
    ): Response<AddItemsResult>

    /**
     * Removes a line the kitchen has not been told about. Refused with 409 once
     * the line is fired — see OrderLineResponse.fired_at.
     *
     * The path is not nested under the order: the line id alone identifies it,
     * and accepting both would invite the till to send a mismatched pair.
     */
    @DELETE("api/pos/orders/items/{itemId}")
    suspend fun removeTabItem(@Path("itemId") itemId: String): Response<Unit>

    /** Sends everything unfired to the kitchen. THIS is where stock moves. */
    @POST("api/pos/orders/{id}/fire")
    suspend fun fireTab(@Path("id") orderId: String): Response<FireResult>

    /** Takes the money. Only now does the tab become revenue. */
    @POST("api/pos/orders/{id}/settle")
    suspend fun settleTab(@Path("id") orderId: String): Response<SettleResult>
}
