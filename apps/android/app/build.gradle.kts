plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.openapi.generator)
}

// 接口代码（#203）：构建时从主站导出的接口文档 api/openapi.json 生成，放在 build/ 里，不进仓库、不手改。
// 主站的接口变了：在仓库根目录运行 pnpm --filter @seekcloud/site openapi:export 重新导出。
val generatedApi = layout.buildDirectory.dir("generated/openapi")
openApiGenerate {
    generatorName.set("kotlin")
    library.set("jvm-okhttp4")
    inputSpec.set(rootProject.file("api/openapi.json").path)
    outputDir.set(generatedApi.get().asFile.path)
    packageName.set("cn.seekcloud.app.api")
    configOptions.set(
        mapOf(
            "serializationLibrary" to "kotlinx_serialization",
            "dateLibrary" to "string",
            "sourceFolder" to "src/main/kotlin",
            "enumPropertyNaming" to "UPPERCASE",
            "omitGradleWrapper" to "true",
        ),
    )
    generateApiTests.set(false)
    generateModelTests.set(false)
    generateApiDocumentation.set(false)
    generateModelDocumentation.set(false)
}

android {
    namespace = "cn.seekcloud.app"
    // Compose 1.13 要求按 37.1 以上编译（安卓的小版本号）
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "cn.seekcloud.app"
        // 安卓 8.0（#123）
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("main") {
            kotlin.srcDir(generatedApi.get().dir("src/main/kotlin").asFile)
        }
    }

    lint {
        abortOnError = true
        // 新版本的提示不算错：升级依赖是单独的事
        disable += setOf("NewerVersionAvailable", "GradleDependency", "AndroidGradlePluginVersion")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
}

tasks.named("preBuild") { dependsOn("openApiGenerate") }
