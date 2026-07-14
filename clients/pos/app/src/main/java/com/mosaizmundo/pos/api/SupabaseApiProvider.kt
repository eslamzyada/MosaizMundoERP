package com.mosaizmundo.pos.api

import com.mosaizmundo.pos.BuildConfig
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/**
 * Builds the Supabase auth client. It's a SEPARATE Retrofit instance from the
 * backend one, pointed at the Supabase project URL and injecting the required
 * `apikey` header. URL and key come from BuildConfig.
 */
object SupabaseApiProvider {
    fun create(): SupabaseApiService {
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request().newBuilder()
                    .addHeader("apikey", BuildConfig.SUPABASE_ANON_KEY)
                    .addHeader("Content-Type", "application/json")
                    .build()
                chain.proceed(request)
            }
            .build()

        val baseUrl = BuildConfig.SUPABASE_URL.trimEnd('/') + "/"
        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(SupabaseApiService::class.java)
    }
}
