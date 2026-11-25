package cn.seekcloud.app

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.seekcloud.app.net.PreferencesStore
import cn.seekcloud.app.settings.AppPreferences
import cn.seekcloud.app.settings.ThemeMode
import cn.seekcloud.app.ui.AppRoot
import cn.seekcloud.app.ui.SeekCloudTheme

/** 唯一的 Activity：界面都在 Compose 里。旋转、分屏、深色模式切换时页面状态由 ViewModel 和 rememberSaveable 保住（#123、#205）。 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // 这台设备上 App 自己的设置（外观、玻璃效果）：整个 App 共用一份，改了马上生效
        val preferences = AppPreferences(PreferencesStore(applicationContext, AppPreferences.FILE))
        setContent {
            val theme by preferences.theme.collectAsStateWithLifecycle()
            val dark = when (theme) {
                ThemeMode.System -> isSystemInDarkTheme()
                ThemeMode.Light -> false
                ThemeMode.Dark -> true
            }
            // 外观固定成浅色或深色时，状态栏和导航栏的图标也跟着换颜色（不跟系统）
            DisposableEffect(dark) {
                enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { dark },
                )
                onDispose {}
            }
            SeekCloudTheme(dark) {
                AppRoot(preferences = preferences)
            }
        }
    }

    private companion object {
        // 三键导航时导航栏的底色，和 enableEdgeToEdge 默认的一样
        val LIGHT_SCRIM = Color.argb(0xe6, 0xFF, 0xFF, 0xFF)
        val DARK_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)
    }
}
