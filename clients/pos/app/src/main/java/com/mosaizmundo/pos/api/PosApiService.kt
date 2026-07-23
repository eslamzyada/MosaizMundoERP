package com.mosaizmundo.pos.api

import retrofit2.Response
import retrofit2.http.Body
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
}
