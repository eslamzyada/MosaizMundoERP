package com.mosaizmundo.pos.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface PosApiService {
    // The POS catalog is the set of sellable items exposed by the recipes read.
    @GET("api/recipes")
    suspend fun getRecipes(): List<RecipeResponse>

    @POST("api/pos/checkout")
    suspend fun checkout(@Body payload: CheckoutPayload): Response<Unit>
}
