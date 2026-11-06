plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ABIs to package. arm64-v8a is the product; CI adds x86_64 for the emulator
// smoke test with -Pparakeet.abis=arm64-v8a,x86_64.
val parakeetAbis = (project.findProperty("parakeet.abis") as String? ?: "arm64-v8a")
    .split(",").map { it.trim() }.filter { it.isNotEmpty() }

android {
    namespace = "dev.parakeet.agent"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.parakeet.agent"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = (project.findProperty("parakeet.version") as String?) ?: "0.1.1"
        ndk { abiFilters += parakeetAbis }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // Self-signed key committed on purpose so every CI build has the same
        // signature and updates install over each other. It protects nothing:
        // do not reuse it for anything you publish.
        create("parakeet") {
            storeFile = file("parakeet-debug.keystore")
            storePassword = "android"
            keyAlias = "parakeet"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("parakeet")
        }
        // The shipped APK. Not debuggable: a debuggable app runs ART without
        // its AOT/JIT optimisations for app *and* WebView glue code, turns on
        // WebView remote debugging and JDWP, which is measurably slower on
        // every frame. R8 shrinks and optimises the Kotlin/AndroidX code.
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("parakeet")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        // node/bash are shipped as lib*.so and exec'd from nativeLibraryDir;
        // they must be extracted to disk, not mapped from the APK.
        jniLibs {
            useLegacyPackaging = true
            // Never strip: these are prebuilt, unmodified Termux ELFs.
            keepDebugSymbols += "**/*.so"
        }
    }

    androidResources {
        // The runtime zip is already compressed.
        noCompress += "zip"
    }

    buildFeatures { buildConfig = true }

    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
