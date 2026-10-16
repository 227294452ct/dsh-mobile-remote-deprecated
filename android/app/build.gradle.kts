plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "local.deepseek.harness.remote"
    compileSdk = 34

    defaultConfig {
        applicationId = "local.deepseek.harness.remote"
        minSdk = 26
        targetSdk = 34
        versionCode = 8
        versionName = "0.2.5"

        // Extra permanent hostnames the app may pair with, comma separated.
        // Quick tunnels keep working; this is for operators running a named
        // tunnel so the phone keeps one address and never has to re-pair.
        //   ./gradlew assembleDebug -PremotePinnedHosts=dsh.example.com
        val pinnedHosts = (project.findProperty("remotePinnedHosts") as String?)
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: "dsh.xinqiaopsy.top"
        buildConfigField("String", "REMOTE_PINNED_HOSTS", "\"$pinnedHosts\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            val keyStorePath = System.getenv("DSH_ANDROID_KEYSTORE")
            if (!keyStorePath.isNullOrBlank()) {
                storeFile = file(keyStorePath)
                storePassword = System.getenv("DSH_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DSH_ANDROID_KEY_ALIAS") ?: "deepseek-harness-remote"
                keyPassword = System.getenv("DSH_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
