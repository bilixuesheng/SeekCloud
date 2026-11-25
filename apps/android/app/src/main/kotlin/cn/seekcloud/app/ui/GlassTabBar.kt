package cn.seekcloud.app.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.kyant.backdrop.backdrops.LayerBackdrop
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberCombinedBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.effects.vibrancy
import com.kyant.backdrop.highlight.Highlight
import com.kyant.backdrop.shadow.InnerShadow
import com.kyant.backdrop.shadow.Shadow
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sign
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

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

/** 底栏的测试标签（界面测试按住、拖动时找它）。 */
const val GLASS_TAB_BAR_TAG = "glass-tab-bar"

/**
 * 浮在内容上面的底部标签栏（#178）。[backdrop] 是下面内容画成的那一层，液态玻璃从它取像素做折射和模糊。
 *
 * 按住的效果照用户参考的 Ghost Downloader 安卓版，做法照 AndroidLiquidGlass 示例程序里的 LiquidBottomTabs
 * （Apache-2.0，作者 Kyant0；动画和手势在 LiquidMotion.kt）：
 * - 选中的那一项上面盖着一块玻璃（透镜），平时是一块淡淡的胶囊；
 * - 按住时透镜鼓起来，带折射、高光和阴影，里面的图标放大、显示成主题色，手指底下有一团光；
 * - 按着能左右拖，拖得快时透镜顺着速度拉长、压扁，整条底栏跟着手指轻轻偏一点；松手落到最近的那一项再缩回去；
 * - 点别的项时透镜滑过去，路上鼓一下。
 * 两版的区别只在折射带不带色散（[style]）。退回毛玻璃时没有折射，退回纯色时透镜是一块不透明的胶囊。
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
    val haptics = LocalHapticFeedback.current
    val accent = MaterialTheme.colorScheme.primary
    val content = MaterialTheme.colorScheme.onSurface
    val surface = if (dark) Color(0xFF1D2027) else Color(0xFFFFFFFF)
    val colorful = style == GlassStyle.Colorful
    val shape = RoundedCornerShape(percent = 50)
    val count = tabs.size.coerceAtLeast(1)
    val last = (count - 1).toFloat()
    val currentSelected by rememberUpdatedState(selected)
    val currentOnSelect by rememberUpdatedState(onSelect)
    // 选中的那一项在透镜下面要显示成主题色：另画一份着了色的图标，录进这一层给透镜用（屏幕上看不见）
    val tabsBackdrop = rememberLayerBackdrop()

    BoxWithConstraints(
        modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .height(TAB_BAR_HEIGHT)
            .testTag(GLASS_TAB_BAR_TAG),
        contentAlignment = Alignment.CenterStart,
    ) {
        val density = LocalDensity.current
        val tabWidth = with(density) { (constraints.maxWidth.toFloat() - 8.dp.toPx()) / count }
        val scope = rememberCoroutineScope()
        // 拖动时整条底栏跟着手指偏一点（最多 4dp），松手弹回
        val panel = remember { Animatable(0f) }
        val panelOffset by remember(density) {
            derivedStateOf {
                val fraction = (panel.value / constraints.maxWidth).coerceIn(-1f, 1f)
                with(density) { 4.dp.toPx() * sign(fraction) * EaseOut.transform(abs(fraction)) }
            }
        }
        var current by remember { mutableIntStateOf(selected) }
        val drag = remember(scope, count) {
            DampedDrag(
                scope = scope,
                initialValue = current.toFloat(),
                valueRange = 0f..last,
                initialScale = 1f,
                // 鼓起来大约 1.4 倍（56dp 高的透镜鼓到 78dp），系统关了动画时不鼓
                pressedScale = if (animationsOff) 1f else 78f / 56f,
                onDragStarted = {},
                onDragStopped = {
                    val target = targetValue.roundToInt().coerceIn(0, count - 1)
                    current = target
                    animateToValue(target.toFloat())
                    scope.launch { panel.animateTo(0f, spring(1f, 300f, 0.5f)) }
                },
                onDrag = { _, amount ->
                    val before = targetValue.roundToInt()
                    updateValue((targetValue + amount.x / tabWidth).coerceIn(0f, last))
                    // 拖过一项时轻轻振一下
                    if (targetValue.roundToInt() != before) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    scope.launch { panel.snapTo(panel.value + amount.x) }
                },
            )
        }
        // 外面换了选中的项（点了某一项、按返回回到第一项）：透镜滑过去
        LaunchedEffect(drag) {
            snapshotFlow { currentSelected }.collect { current = it }
        }
        LaunchedEffect(drag) {
            snapshotFlow { current }.drop(1).collect { index ->
                if (animationsOff) drag.snapTo(index.toFloat()) else drag.animateToValue(index.toFloat())
                if (index != currentSelected) currentOnSelect(index)
            }
        }
        val glow = remember(scope) {
            PressGlow(scope) { size, _ ->
                Offset((drag.value + 0.5f) * tabWidth + panelOffset, size.height / 2f)
            }
        }
        val liquid = render == GlassRender.Liquid
        val solid = render == GlassRender.Solid
        val iconsOnly = density.fontScale > 1.5f

        // 底下那条玻璃和每一项（点得到、读屏读得到的是这一层）
        Row(
            Modifier
                .graphicsLayer { translationX = panelOffset }
                .then(
                    if (solid) {
                        Modifier.background(surface.copy(alpha = 0.94f), shape)
                    } else {
                        Modifier.drawBackdrop(
                            backdrop = backdrop,
                            shape = { shape },
                            effects = {
                                vibrancy()
                                blur(if (liquid) 8.dp.toPx() else 16.dp.toPx())
                                if (liquid) lens(24.dp.toPx(), 24.dp.toPx(), chromaticAberration = colorful)
                            },
                            highlight = { Highlight.Default.copy(alpha = if (dark) 0.6f else 0.9f) },
                            layerBlock = {
                                val scale = lerp(1f, 1f + 16.dp.toPx() / size.width, drag.pressProgress)
                                scaleX = scale
                                scaleY = scale
                            },
                            onDrawSurface = { drawRect(surface.copy(alpha = if (liquid) 0.4f else 0.6f)) },
                        )
                    },
                )
                .then(glow.modifier)
                .height(TAB_BAR_HEIGHT)
                .fillMaxWidth()
                .padding(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tabs.forEachIndexed { index, tab ->
                val isSelected = index == selected
                TabCell(
                    tab = tab,
                    icon = if (isSelected && solid) tab.selectedIcon else tab.icon,
                    color = if (isSelected && solid) accent else content,
                    iconsOnly = iconsOnly,
                    scale = { 1f },
                    modifier = Modifier
                        .clickable(interactionSource = null, indication = null, role = Role.Tab) { current = index }
                        .clearAndSetSemantics {
                            contentDescription = tab.label
                            role = Role.Tab
                            this.selected = isSelected
                            onClick {
                                current = index
                                true
                            }
                        },
                )
            }
        }

        if (!solid) {
            // 着了主题色的一份（看不见，只录进 tabsBackdrop）：透镜底下显示它，按住时图标放大到 1.2 倍
            Row(
                Modifier
                    .clearAndSetSemantics {}
                    .alpha(0f)
                    .layerBackdrop(tabsBackdrop)
                    .graphicsLayer { translationX = panelOffset }
                    .drawBackdrop(
                        backdrop = backdrop,
                        shape = { shape },
                        effects = {
                            vibrancy()
                            blur(if (liquid) 8.dp.toPx() else 16.dp.toPx())
                            if (liquid) {
                                val progress = drag.pressProgress
                                lens(24.dp.toPx() * progress, 24.dp.toPx() * progress, chromaticAberration = colorful)
                            }
                        },
                        highlight = { Highlight.Default.copy(alpha = drag.pressProgress) },
                        onDrawSurface = { drawRect(surface.copy(alpha = if (liquid) 0.4f else 0.6f)) },
                    )
                    .then(glow.modifier)
                    .height(56.dp)
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp)
                    .graphicsLayer(colorFilter = ColorFilter.tint(accent)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                tabs.forEach { tab ->
                    TabCell(
                        tab = tab,
                        icon = tab.selectedIcon,
                        color = accent,
                        iconsOnly = iconsOnly,
                        scale = { lerp(1f, 1.2f, drag.pressProgress) },
                        modifier = Modifier,
                    )
                }
            }
        }

        // 透镜：盖在选中的那一项上，接按住和拖动
        Box(
            Modifier
                .padding(horizontal = 4.dp)
                .graphicsLayer { translationX = drag.value * tabWidth + panelOffset }
                .then(glow.gestureModifier)
                .then(drag.modifier)
                .then(
                    if (solid) {
                        Modifier
                            .graphicsLayer {
                                scaleX = drag.scaleX
                                scaleY = drag.scaleY
                            }
                            .background(accent.copy(alpha = if (dark) 0.22f else 0.12f), shape)
                    } else {
                        Modifier.drawBackdrop(
                            backdrop = rememberCombinedBackdrop(backdrop, tabsBackdrop),
                            shape = { shape },
                            effects = {
                                if (liquid) {
                                    val progress = drag.pressProgress
                                    lens(10.dp.toPx() * progress, 14.dp.toPx() * progress, chromaticAberration = colorful)
                                }
                            },
                            highlight = { Highlight.Default.copy(alpha = drag.pressProgress) },
                            shadow = { Shadow(alpha = drag.pressProgress) },
                            innerShadow = { InnerShadow(radius = 8.dp * drag.pressProgress, alpha = drag.pressProgress) },
                            layerBlock = {
                                scaleX = drag.scaleX
                                scaleY = drag.scaleY
                                // 拖得快时顺着方向拉长、上下压扁
                                val velocity = drag.velocity / 10f
                                scaleX /= 1f - (velocity * 0.75f).coerceIn(-0.2f, 0.2f)
                                scaleY *= 1f - (velocity * 0.25f).coerceIn(-0.2f, 0.2f)
                            },
                            onDrawSurface = {
                                val progress = drag.pressProgress
                                // 平时是一块淡淡的胶囊，鼓起来以后变成透明的玻璃
                                drawRect(if (dark) Color.White.copy(0.1f) else Color.Black.copy(0.1f), alpha = 1f - progress)
                                drawRect(Color.Black.copy(alpha = 0.03f * progress))
                            },
                        )
                    },
                )
                .height(56.dp)
                .fillMaxWidth(1f / count),
        )
        // 纯色的透镜画在图标上面会盖住它们：再画一遍选中的那一项
        if (solid) {
            Box(
                Modifier
                    .padding(horizontal = 4.dp)
                    .graphicsLayer { translationX = drag.value * tabWidth + panelOffset }
                    .height(56.dp)
                    .fillMaxWidth(1f / count)
                    .clearAndSetSemantics {},
            ) {
                val tab = tabs.getOrNull(drag.targetValue.roundToInt()) ?: return@Box
                TabCell(tab, tab.selectedIcon, accent, iconsOnly, scale = { 1f }, modifier = Modifier.fillMaxSize())
            }
        }
    }
}

/** 底栏的一项：图标，下面一行字；字放大到放不下时只显示图标。 */
@Composable
private fun RowScope.TabCell(
    tab: TabItem,
    icon: Int,
    color: Color,
    iconsOnly: Boolean,
    scale: () -> Float,
    modifier: Modifier,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(percent = 50))
            .fillMaxHeight()
            .weight(1f)
            .graphicsLayer {
                val s = scale()
                scaleX = s
                scaleY = s
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = color, modifier = Modifier.size(24.dp))
        if (!iconsOnly) {
            Text(tab.label, color = color, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** 纯色退回时，透镜上重画选中项用的格子（不在 Row 里）。 */
@Composable
private fun TabCell(tab: TabItem, icon: Int, color: Color, iconsOnly: Boolean, scale: () -> Float, modifier: Modifier) {
    Row(modifier) { TabCell(tab, icon, color, iconsOnly, scale, Modifier) }
}

private fun lerp(start: Float, stop: Float, fraction: Float) = start + (stop - start) * fraction
