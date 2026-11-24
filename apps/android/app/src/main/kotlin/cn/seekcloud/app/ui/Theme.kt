package cn.seekcloud.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// 颜色照 docs/brand/README.md 和主站 apps/site/src/client/styles.css 的变量：浅色、深色各一套
private val Light = lightColorScheme(
    primary = Color(0xFF4566F5),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEAF0FF),
    onPrimaryContainer = Color(0xFF3656E6),
    background = Color(0xFFFBFCFF),
    onBackground = Color(0xFF171A23),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF171A23),
    onSurfaceVariant = Color(0xFF677084),
    outline = Color(0xFFCDD5E4),
    outlineVariant = Color(0xFFE3E8F2),
    error = Color(0xFFD4423B),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF4D6BFE),
    onPrimary = Color.White,
    primaryContainer = Color(0xFF26315C),
    onPrimaryContainer = Color(0xFF94A7FF),
    background = Color(0xFF15171C),
    onBackground = Color(0xFFE6E9F0),
    surface = Color(0xFF1D2027),
    onSurface = Color(0xFFE6E9F0),
    error = Color(0xFFF06B64),
)

@Composable
fun SeekCloudTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
}
