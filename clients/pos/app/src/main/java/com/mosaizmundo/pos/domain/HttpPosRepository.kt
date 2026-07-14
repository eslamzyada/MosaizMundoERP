package com.mosaizmundo.pos.domain

import com.mosaizmundo.pos.api.CheckoutItemPayload
import com.mosaizmundo.pos.api.CheckoutPayload
import com.mosaizmundo.pos.api.PosApiService
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.IOException
import java.util.UUID

/**
 * Live implementation of PosRepository (Retrofit + Gson). The menu comes from
 * GET /api/recipes; checkout POSTs to /api/pos/checkout with a freshly generated
 * client_offline_id, so a dropped-then-retried request is idempotent server-side.
 */
class HttpPosRepository(baseUrl: String = DEFAULT_BASE_URL) : PosRepository {

    private val api: PosApiService = Retrofit.Builder()
        .baseUrl(baseUrl)
        .addConverterFactory(GsonConverterFactory.create())
        .build()
        .create(PosApiService::class.java)

    override suspend fun getMenu(): List<SellableItem> =
        api.getRecipes().map { recipe ->
            // Real price now comes from the backend (migration 0008); image is
            // still a placeholder until the schema carries one.
            SellableItem(
                id = recipe.id,
                nameAr = recipe.name,
                price = recipe.price,
                imagePlaceholder = "🍽️",
            )
        }

    override suspend fun submitOrder(orderState: OrderState) {
        val payload = CheckoutPayload(
            organization_id = ORGANIZATION_ID,
            client_offline_id = UUID.randomUUID().toString(),
            total_amount = orderState.totalAmount,
            items = orderState.items.map { line ->
                CheckoutItemPayload(
                    sellable_item_id = line.sellableItem.id,
                    quantity = line.quantity,
                    unit_price = line.sellableItem.price,
                )
            },
        )
        val response = api.checkout(payload)
        if (!response.isSuccessful) {
            throw IOException("Checkout failed with HTTP ${response.code()}")
        }
    }

    companion object {
        // 10.0.2.2 is the host machine as seen from the Android emulator.
        const val DEFAULT_BASE_URL = "http://10.0.2.2:3000/"

        // TODO: source from the authenticated session once POS auth lands. The
        // backend also needs a valid bearer token; that is a later phase.
        private const val ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000"
    }
}
