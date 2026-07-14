package com.mosaizmundo.pos.api

import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/** Builds the Retrofit-backed PosApiService — shared by the repository and the sync worker. */
object PosApiProvider {
    // 10.0.2.2 is the host machine as seen from the Android emulator.
    const val DEFAULT_BASE_URL = "http://10.0.2.2:3000/"

    fun create(baseUrl: String = DEFAULT_BASE_URL): PosApiService =
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(PosApiService::class.java)
}
