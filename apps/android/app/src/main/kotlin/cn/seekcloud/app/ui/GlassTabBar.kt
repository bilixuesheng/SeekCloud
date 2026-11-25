package cn.seekcloud.app.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.kyant.backdrop.backdrops.LayerBackdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.effects.vibrancy
import com.kyant.backdrop.highlight.Highlight
import kotlin.math.roundToInt

/**
 * 玻璃效果的两版（#178 的 2026-11-22 评论，用户定的）：光效（折射、边缘高光、按压的形变）一样，只差颜色。
 * [Colorful]：边缘的折射带色散，红、绿、蓝分开折射，像棱镜那样有彩边；[Plain]：没有多余的颜色。
 */
enum class GlassStyle { Colorful, Plain }

/** 底栏实际怎么画：液态玻璃（安卓 13 以上）、毛玻璃（安卓 12、省电模式、掉帧）、半透明的纯色（更老的系统）。 */
enum class GlassRender { Liquid, Frosted, Solid }

/**
 * 按系统版本和状态挑底栏的画法（#178）：液态玻璃要 RuntimeShader（安卓 13，API 33）；模糊要 RenderEffect（安卓 12，API 31）。
 * 省电模式、检测到掉帧时退一级，不再画折射。[forced] 是测试截图时指定的（不在界面上出现）。
 */
fun chooseGlassRender(sdk: Int, powerSave: Boolean, slow: Boolean, forced: GlassRender? = null): GlassRender {
    val best = when {
        sdk >= 33 && !powerSave && !slow -> GlassRender.Liquid
        sdk >= 31 -> GlassRender.Frosted
        else -> GlassRender.Solid
    }
    // 指定的画法不能比设备支持的更好
    return if (forced != null && forced.ordinal >= best.ordinal) forced else best
}

/** 底栏的一项。 */
data class TabItem(val label: String, val icon: Int, val selectedIcon: Int)

/** 底栏的高度（不含系统导航栏）：内容在它下面能滚到底，最后一行不被挡住。 */
val TAB_BAR_HEIGHT: Dp = 64.dp
/** 底栏和屏幕底边的距离。 */
val TAB_BAR_MARGIN: Dp = 12.dp

/** 系统是不是开着省电模式，变了跟着变。 */
@Composable
fun rememberPowerSave(): Boolean {
    val context = LocalContext.current
    val power = remember { context.getSystemService(PowerManager::class.java) }
    var on by remember { mutableStateOf(power?.isPowerSaveMode == true) }
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                on = power?.isPowerSaveMode == true
            }
        }
        val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
        onDispose { context.unregisterReceiver(receiver) }
    }
    return on
}

/** 系统的"移除动画"开着没有（开发者选项或无障碍里的）。 */
@Composable
fun rememberAnimationsOff(): Boolean {
    val context = LocalContext.current
    return remember { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

/**
 * 掉帧检测：底栏出现后的头 120 帧里，超过三成的帧间隔比 1/40 秒还长，就当这台机器画液态玻璃跟不上，
 * 这次打开 App 期间退回毛玻璃（下次打开重新量）。
 */
@Composable
fun rememberSlowRendering(enabled: Boolean): Boolean {
    var slow by remember { mutableStateOf(false) }
    LaunchedEffect(enabled) {
        if (!enabled || slow) return@LaunchedEffect
        var last = withFrameNanos { it }
        var long = 0
        repeat(120) {
            val now = withFrameNanos { it }
            if (now - last > 25_000_000L) long++
            last = now
        }
        // 前几帧是启动、首次合成，不算
        if (long > 40) slow = true
    }
    return slow
}

/**
 * 浮在内容上面的底部标签栏（#178）。[backdrop] 是下面内容画成的那一层，液态玻璃从它取像素做折射和模糊。
 * 选中项的高亮在几项之间滑动；按下时整条轻轻放大（形变）。字放大到放不下时只显示图标。
 */
@Composable
fun GlassTabBar(
    backdrop: LayerBackdrop,
    tabs: List<TabItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    style: GlassStyle,
    render: GlassRender,
    modifier: Modifier = Modifier,
) {
    val dark = LocalDarkTheme.current
    val animationsOff = rememberAnimationsOff()
    val shape = RoundedCornerShape(percent = 50)
    val tint = if (dark) Color(0xFF1D2027) else Color(0xFFFFFFFF)
    val density = LocalDensity.current
    // 按着底栏时整条轻轻放大（液态玻璃的形变），松开弹回
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        if (pressed && !animationsOff) 1.04f else 1f,
        if (animationsOff) tween(0) else spring(dampingRatio = 0.6f, stiffness = Spring.StiffnessMediumLow),
        label = "tab-bar-press",
    )
    val glass = when (render) {
        GlassRender.Liquid -> Modifier.drawBackdrop(
            backdrop = backdrop,
            shape = { shape },
            effects = {
                vibrancy()
                blur(with(density) { 4.dp.toPx() })
                lens(
                    refractionHeight = with(density) { 14.dp.toPx() },
                    refractionAmount = with(density) { 28.dp.toPx() },
                    chromaticAberration = style == GlassStyle.Colorful,
                )
            },
            highlight = { Highlight.Default.copy(alpha = if (dark) 0.6f else 0.9f) },
            layerBlock = {
                scaleX = scale
                scaleY = scale
            },
            onDrawSurface = { drawRect(tint.copy(alpha = if (dark) 0.28f else 0.36f)) },
        )
        GlassRender.Frosted -> Modifier.drawBackdrop(
            backdrop = backdrop,
            shape = { shape },
            effects = {
                vibrancy()
                blur(with(density) { 16.dp.toPx() })
            },
            highlight = { Highlight.Default.copy(alpha = if (dark) 0.4f else 0.7f) },
            layerBlock = {
                scaleX = scale
                scaleY = scale
            },
            onDrawSurface = { drawRect(tint.copy(alpha = if (dark) 0.55f else 0.62f)) },
        )
        GlassRender.Solid -> Modifier.background(tint.copy(alpha = 0.94f), shape)
    }
    BoxWithConstraints(
        modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .height(TAB_BAR_HEIGHT)
            .then(glass),
    ) {
        val count = tabs.size.coerceAtLeast(1)
        val itemWidth = maxWidth / count
        // 选中的高亮滑到新的一项（照 Claude 的 App）；移除动画时直接到位
        val offset = remember { Animatable(selected.toFloat()) }
        LaunchedEffect(selected, animationsOff) {
            if (animationsOff) offset.snapTo(selected.toFloat())
            else offset.animateTo(selected.toFloat(), spring(dampingRatio = 0.75f, stiffness = Spring.StiffnessMediumLow))
        }
        val itemPx = with(density) { itemWidth.roundToPx() }
        Box(
            Modifier
                .offset { IntOffset((itemPx * offset.value).roundToInt(), 0) }
                .width(itemWidth)
                .fillMaxHeight()
                .padding(6.dp)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = if (dark) 0.22f else 0.12f), shape),
        )
        // 系统字体放到很大时只显示图标（字放不下）
        val iconsOnly = LocalDensity.current.fontScale > 1.5f
        Row(Modifier.fillMaxSize()) {
            tabs.forEachIndexed { index, tab ->
                val isSelected = index == selected
                val color = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clickable(interactionSource = interaction, indication = null) { onSelect(index) }
                        .clearAndSetSemantics {
                            contentDescription = tab.label
                            role = Role.Tab
                            this.selected = isSelected
                            onClick {
                                onSelect(index)
                                true
                            }
                        },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(
                        painterResource(if (isSelected) tab.selectedIcon else tab.icon),
                        contentDescription = null,
                        tint = color,
                        modifier = Modifier.size(24.dp),
                    )
                    if (!iconsOnly) {
                        Spacer(Modifier.height(2.dp))
                        Text(
                            tab.label,
                            color = color,
                            style = MaterialTheme.typography.labelSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}
