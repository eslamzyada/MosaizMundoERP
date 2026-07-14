package com.mosaizmundo.pos.api

import android.content.Context
import com.mosaizmundo.pos.data.local.TokenManager
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/**
 * Builds the backend PosApiService — shared by the repository and the sync
 * worker. The OkHttp client injects the current Supabase access token (read
 * from TokenManager) as a Bearer header on every request.
 */
object PosApiProvider {
    // 10.0.2.2 is the host machine as seen from the Android emulator.
    const val DEFAULT_BASE_URL = "http://10.0.2.2:3000/"

    fun create(context: Context, baseUrl: String = DEFAULT_BASE_URL): PosApiService {
        val tokenManager = TokenManager(context.applicationContext)

        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                // The interceptor runs on OkHttp's network thread, so a blocking
                // read of the (in-memory-cached) token is acceptable here.
                val token = runBlocking { tokenManager.getToken().first() }
                val request = if (!token.isNullOrBlank()) {
                    chain.request().newBuilder()
                        .addHeader("Authorization", "Bearer $token")
                        .build()
                } else {
                    chain.request()
                }
                chain.proceed(request)
            }
            .build()

        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(PosApiService::class.java)
    }
}
