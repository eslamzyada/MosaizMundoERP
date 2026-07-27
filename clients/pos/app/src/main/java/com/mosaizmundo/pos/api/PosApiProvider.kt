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
                // A request may carry its own Authorization — a manager
                // authorising a single void at a till signed in as a cashier.
                // That token is passed per-call and never persisted, so the
                // stored session must not overwrite it.
                val explicitAuth = chain.request().header("Authorization") != null
                val token = runBlocking { tokenManager.getToken().first() }
                val builder = chain.request().newBuilder()
                // Marks a per-call token so SessionAuthenticator does not treat
                // a manager's one-off authorisation as this shift's session and
                // sign the cashier out when it is refused.
                if (explicitAuth) builder.addHeader("X-Explicit-Auth", "true")
                    // ngrok's free tier returns an HTML interstitial to non-browser
                    // clients unless this header is present; without it the JSON
                    // parser would receive HTML. Harmless against a non-ngrok host.
                    .addHeader("ngrok-skip-browser-warning", "true")
                if (!explicitAuth && !token.isNullOrBlank()) {
                    builder.addHeader("Authorization", "Bearer $token")
                }
                chain.proceed(builder.build())
            }
            // Fires only on 401: renews the session and retries, or clears it
            // so the app returns to the login screen on its own.
            .authenticator(SessionAuthenticator(tokenManager, SupabaseApiProvider.create()))
            .build()

        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(PosApiService::class.java)
    }
}
