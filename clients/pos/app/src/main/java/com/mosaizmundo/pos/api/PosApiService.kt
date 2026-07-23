package com.mosaizmundo.pos.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface PosApiService {
    // The authenticated user's organization (used to fill the checkout payload).
    @GET("api/me")
    suspend fun getMe(): UserMetadata

    // The POS catalog. /api/pos/menu carries what a till needs — name, price,
    // and how many portions the stock on hand still allows. The POS used to read
    // /api/recipes, which also returns food costs the till has no business
    // holding on a device that leaves the office.
    @GET("api/pos/menu")
    suspend fun getMenu(): List<MenuItemResponse>

    @POST("api/pos/checkout")
    suspend fun checkout(@Body payload: CheckoutPayload): Response<Unit>
}
