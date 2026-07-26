import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

// Local, gitignored overrides (Supabase keys + backend URL) live in
// clients/pos/local.properties. Any missing key falls back to a safe default so
// the build still compiles without the file (e.g. on CI, where it doesn't exist).
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
// A value may be written with or without surrounding quotes in local.properties;
// strip a matched pair (and trim) so we never emit doubled quotes into BuildConfig.
fun localConfig(key: String, default: String): String =
    (localProperties.getProperty(key) ?: default).trim().removeSurrounding("\"")

android {
    namespace = "com.mosaizmundo.pos"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mosaizmundo.pos"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // Provided via clients/pos/local.properties (gitignored). The fallbacks
        // keep CI compiling without that file. 10.0.2.2 is the emulator's alias
        // for the host loopback; override BACKEND_BASE_URL for a LAN IP or tunnel.
        val supabaseUrl = localConfig("SUPABASE_URL", "https://your-project.supabase.co")
        val supabaseAnonKey = localConfig("SUPABASE_ANON_KEY", "your-supabase-anon-key")
        val backendBaseUrl = localConfig("BACKEND_BASE_URL", "http://10.0.2.2:3000/")

        // Build-time confirmation that local.properties was actually read.
        println("[MosaizPOS build] BACKEND_BASE_URL resolved to: $backendBaseUrl")

        buildConfigField("String", "SUPABASE_URL", "\"$supabaseUrl\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"$supabaseAnonKey\"")
        buildConfigField("String", "BACKEND_BASE_URL", "\"$backendBaseUrl\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        // Must match the Kotlin version (1.9.24 -> 1.5.14).
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// JVM unit tests. The ESC/POS encoder, the ticket content and the socket
// transport are deliberately free of Android types so they can be tested here
// rather than on a device — the byte stream is exactly the part where a
// mistake produces a metre of garbage instead of a ticket.
dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.google.code.gson:gson:2.10.1")

    // Offline-first: Room queue + WorkManager sync.
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
}
