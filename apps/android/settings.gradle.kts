// SeekCloud 的安卓 App（#122、#123）：Kotlin + Jetpack Compose + Material 3。不进 pnpm 的工作区，有自己的 CI（.github/workflows/android.yml）。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SeekCloud"
include(":app")
