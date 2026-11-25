/*
 * 改写自 AndroidLiquidGlass（https://github.com/Kyant0/AndroidLiquidGlass，作者 Kyant0）示例程序里的
 * DampedDragAnimation、InteractiveHighlight 和 DragGestureInspector，依据 Apache License 2.0 使用，
 * 许可证全文见 https://www.apache.org/licenses/LICENSE-2.0 。
 *
 * 改动（#178）：合进一个文件、改成内部类、改了名字；时间改用 SystemClock；加了直接到位的 snapTo；
 * 注释改成中文。
 */
package cn.seekcloud.app.ui

import android.os.SystemClock
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.foundation.MutatorMutex
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.unit.IntSize
import com.kyant.backdrop.RuntimeShader
import com.kyant.backdrop.asComposeShader
import com.kyant.backdrop.isRuntimeShaderSupported
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * 按住、拖动、松手的弹簧动画（底栏的透镜、玻璃按钮用）：[value] 是透镜在第几项（可以是小数，拖着时在两项之间），
 * [pressProgress] 是鼓起的程度（0 到 1），[scaleX]、[scaleY] 是鼓起时放大的倍数，[velocity] 是拖动的速度（拉长、压扁用）。
 */
internal class DampedDrag(
    private val scope: CoroutineScope,
    initialValue: Float,
    private val valueRange: ClosedFloatingPointRange<Float>,
    private val initialScale: Float,
    private val pressedScale: Float,
    private val onDragStarted: DampedDrag.(position: Offset) -> Unit,
    private val onDragStopped: DampedDrag.() -> Unit,
    private val onDrag: DampedDrag.(size: IntSize, dragAmount: Offset) -> Unit,
) {
    private val valueSpec = spring(1f, 1000f, VISIBILITY)
    private val velocitySpec = spring(0.5f, 300f, VISIBILITY * 10f)
    private val pressSpec = spring(1f, 1000f, 0.001f)
    private val scaleXSpec = spring(0.6f, 250f, 0.001f)
    private val scaleYSpec = spring(0.7f, 250f, 0.001f)

    private val valueAnimation = Animatable(initialValue, VISIBILITY)
    private val velocityAnimation = Animatable(0f, 5f)
    private val pressAnimation = Animatable(0f, 0.001f)
    private val scaleXAnimation = Animatable(initialScale, 0.001f)
    private val scaleYAnimation = Animatable(initialScale, 0.001f)
    private val mutex = MutatorMutex()
    private val velocityTracker = VelocityTracker()

    val value: Float get() = valueAnimation.value
    val targetValue: Float get() = valueAnimation.targetValue
    val pressProgress: Float get() = pressAnimation.value
    val scaleX: Float get() = scaleXAnimation.value
    val scaleY: Float get() = scaleYAnimation.value
    val velocity: Float get() = velocityAnimation.value

    val modifier: Modifier = Modifier.pointerInput(Unit) {
        inspectDrag(
            onStart = { down ->
                onDragStarted(down.position)
                press()
            },
            onEnd = {
                onDragStopped()
                release()
            },
            onCancel = {
                onDragStopped()
                release()
            },
        ) { _, dragAmount -> onDrag(size, dragAmount) }
    }

    /** 鼓起来。 */
    fun press() {
        velocityTracker.resetTracking()
        scope.launch {
            launch { pressAnimation.animateTo(1f, pressSpec) }
            launch { scaleXAnimation.animateTo(pressedScale, scaleXSpec) }
            launch { scaleYAnimation.animateTo(pressedScale, scaleYSpec) }
        }
    }

    /** 落到位以后缩回去（还在滑的时候等它快到了再缩）。 */
    fun release() {
        scope.launch {
            withFrameNanos { }
            if (value != targetValue) {
                val threshold = (valueRange.endInclusive - valueRange.start) * 0.025f
                snapshotFlow { valueAnimation.value }
                    .filter { abs(it - valueAnimation.targetValue) < threshold }
                    .first()
            }
            launch { pressAnimation.animateTo(0f, pressSpec) }
            launch { scaleXAnimation.animateTo(initialScale, scaleXSpec) }
            launch { scaleYAnimation.animateTo(initialScale, scaleYSpec) }
        }
    }

    /** 跟着手指走。 */
    fun updateValue(value: Float) {
        val target = value.coerceIn(valueRange)
        scope.launch { valueAnimation.animateTo(target, valueSpec) { updateVelocity() } }
    }

    /** 滑到某一项，路上鼓一下（点别的项时）。 */
    fun animateToValue(value: Float) {
        scope.launch {
            mutex.mutate {
                press()
                val target = value.coerceIn(valueRange)
                launch { valueAnimation.animateTo(target, valueSpec) }
                if (velocity != 0f) launch { velocityAnimation.animateTo(0f, velocitySpec) }
                release()
            }
        }
    }

    /** 直接到位（系统关了动画时）。 */
    fun snapTo(value: Float) {
        scope.launch { valueAnimation.snapTo(value.coerceIn(valueRange)) }
    }

    private fun updateVelocity() {
        velocityTracker.addPosition(SystemClock.uptimeMillis(), Offset(value, 0f))
        val target = velocityTracker.calculateVelocity().x / (valueRange.endInclusive - valueRange.start)
        scope.launch { velocityAnimation.animateTo(target, velocitySpec) }
    }

    private companion object {
        const val VISIBILITY = 0.001f
    }
}

/**
 * 按住时手指底下的一团光，跟着手指走（安卓 13 以上用着色器画成圆形的光，更老的系统整块提亮一点）。
 * [modifier] 加在被照亮的那一层上，[gestureModifier] 加在接手势的那一层上。
 */
internal class PressGlow(
    private val scope: CoroutineScope,
    private val position: (size: Size, offset: Offset) -> Offset = { _, offset -> offset },
) {
    private val pressSpec = spring(0.5f, 300f, 0.001f)
    private val positionSpec = spring(0.5f, 300f, Offset.VisibilityThreshold)
    private val pressAnimation = Animatable(0f, 0.001f)
    private val positionAnimation = Animatable(Offset.Zero, Offset.VectorConverter, Offset.VisibilityThreshold)
    private var start = Offset.Zero

    private val shader = if (isRuntimeShaderSupported()) {
        RuntimeShader(
            """
uniform float2 size;
layout(color) uniform half4 color;
uniform float radius;
uniform float2 position;

half4 main(float2 coord) {
    float dist = distance(coord, position);
    float intensity = smoothstep(radius, radius * 0.5, dist);
    return color * intensity;
}""",
        )
    } else {
        null
    }

    val modifier: Modifier = Modifier.drawWithContent {
        val progress = pressAnimation.value
        if (progress > 0f) {
            if (shader != null) {
                drawRect(Color.White.copy(0.08f * progress), blendMode = BlendMode.Plus)
                val at = position(size, positionAnimation.value)
                shader.setFloatUniform("size", size.width, size.height)
                shader.setColorUniform("color", Color.White.copy(0.15f * progress))
                shader.setFloatUniform("radius", size.minDimension * 1.5f)
                shader.setFloatUniform("position", at.x.coerceIn(0f, size.width), at.y.coerceIn(0f, size.height))
                drawRect(ShaderBrush(shader.asComposeShader()), blendMode = BlendMode.Plus)
            } else {
                drawRect(Color.White.copy(0.25f * progress), blendMode = BlendMode.Plus)
            }
        }
        drawContent()
    }

    val gestureModifier: Modifier = Modifier.pointerInput(scope) {
        inspectDrag(
            onStart = { down ->
                start = down.position
                scope.launch {
                    launch { pressAnimation.animateTo(1f, pressSpec) }
                    launch { positionAnimation.snapTo(start) }
                }
            },
            onEnd = { settle() },
            onCancel = { settle() },
        ) { change, _ -> scope.launch { positionAnimation.snapTo(change.position) } }
    }

    private fun settle() {
        scope.launch {
            launch { pressAnimation.animateTo(0f, pressSpec) }
            launch { positionAnimation.animateTo(start, positionSpec) }
        }
    }
}

/**
 * 看着手指按下、拖动、抬起，但不吃掉事件（下面的点击照常收到）。按下就算开始，抬起算结束，
 * 别的手势把事件吃掉了算取消。
 */
internal suspend fun PointerInputScope.inspectDrag(
    onStart: (down: PointerInputChange) -> Unit = {},
    onEnd: (change: PointerInputChange) -> Unit = {},
    onCancel: () -> Unit = {},
    onDrag: (change: PointerInputChange, dragAmount: Offset) -> Unit,
) {
    awaitEachGesture {
        val initialDown = awaitFirstDown(false, PointerEventPass.Initial)
        val down = awaitFirstDown(false)
        onStart(down)
        onDrag(initialDown, Offset.Zero)
        val up = trackDrag(initialDown.id) { onDrag(it, it.positionChange()) }
        if (up == null) onCancel() else onEnd(up)
    }
}

private suspend inline fun AwaitPointerEventScope.trackDrag(
    pointerId: PointerId,
    onDrag: (PointerInputChange) -> Unit,
): PointerInputChange? {
    if (currentEvent.changes.firstOrNull { it.id == pointerId }?.pressed != true) return null
    var pointer = pointerId
    while (true) {
        val change = awaitDragOrUp(pointer) ?: return null
        if (change.isConsumed) return null
        if (change.changedToUpIgnoreConsumed()) return change
        onDrag(change)
        pointer = change.id
    }
}

private suspend inline fun AwaitPointerEventScope.awaitDragOrUp(pointerId: PointerId): PointerInputChange? {
    var pointer = pointerId
    while (true) {
        val event = awaitPointerEvent()
        val change = event.changes.firstOrNull { it.id == pointer } ?: return null
        if (change.changedToUpIgnoreConsumed()) {
            val other = event.changes.firstOrNull { it.pressed } ?: return change
            pointer = other.id
        } else if (change.previousPosition != change.position) {
            return change
        }
    }
}
