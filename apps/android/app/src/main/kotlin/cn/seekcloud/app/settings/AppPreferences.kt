package cn.seekcloud.app.settings

import cn.seekcloud.app.net.KeyValueStore
import cn.seekcloud.app.ui.GlassRender
import cn.seekcloud.app.ui.GlassStyle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 这台设备上 App 自己的设置（不随主站，#178、#181）：玻璃效果用哪一版。改了马上生效，不用重启 App。
 * 默认用哪一版等用户在手机上看过两版以后再定（#178 的 2026-11-22 评论），先用彩色折射。
 */
class AppPreferences(private val store: KeyValueStore) {
    private val _glass = MutableStateFlow(store.get(GLASS)?.let { name -> GlassStyle.entries.firstOrNull { it.name == name } } ?: GlassStyle.Colorful)
    val glass: StateFlow<GlassStyle> = _glass.asStateFlow()

    fun setGlass(style: GlassStyle) {
        store.put(GLASS, style.name)
        _glass.value = style
    }

    /** 指定的底栏画法：只有界面测试截图时写（看毛玻璃、纯色的退回），界面上没有这一项。 */
    val forcedRender: GlassRender?
        get() = store.get(RENDER)?.let { name -> GlassRender.entries.firstOrNull { it.name == name } }

    companion object {
        /** 存在哪个 SharedPreferences 里（界面测试也写这里）。 */
        const val FILE = "app-settings"
        const val GLASS = "glass"
        const val RENDER = "glass_render"
    }
}
