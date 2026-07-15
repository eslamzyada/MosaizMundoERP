package com.mosaizmundo.pos.api

import android.content.Context
import com.mosaizmundo.pos.BuildConfig
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
    // Comes from BuildConfig (set via local.properties; default
    // http://10.0.2.2:3000/ — the emulator's alias for the host loopback).
    // Normalized to exactly one trailing slash, which Retrofit requires.
    val DEFAULT_BASE_URL: String = BuildConfig.BACKEND_BASE_URL.trimEnd('/') + "/"

    fun create(context: Context, baseUrl: String = DEFAULT_BASE_URL): PosApiService {
        // Debug builds only: prints the exact URL Retrofit will use (filter: DEBUG_URL).
        if (BuildConfig.DEBUG) {
            android.util.Log.d(
                "DEBUG_URL",
                "PosApi Retrofit baseUrl=$baseUrl (BuildConfig.BACKEND_BASE_URL=${BuildConfig.BACKEND_BASE_URL})",
            )
        }
        val tokenManager = TokenManager(context.applicationContext)

        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                // The interceptor runs on OkHttp's network thread, so a blocking
                // read of the (in-memory-cached) token is acceptable here.
                val token = runBlocking { tokenManager.getToken().first() }
                val builder = chain.request().newBuilder()
                    // ngrok's free tier returns an HTML interstitial to non-browser
                    // clients unless this header is present; without it the JSON
                    // parser would receive HTML. Harmless against a non-ngrok host.
                    .addHeader("ngrok-skip-browser-warning", "true")
                if (!token.isNullOrBlank()) {
                    builder.addHeader("Authorization", "Bearer $token")
                }
                chain.proceed(builder.build())
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
