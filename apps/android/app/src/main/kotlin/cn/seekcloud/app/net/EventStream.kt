package cn.seekcloud.app.net

import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * 事件流里的一条（SSE）。[id] 是会话里的序号，只有落了库的事件才有；逐字输出这类只推送的没有（#31）。
 * [event] 没写时是 `message`，和浏览器一样。
 */
data class SseEvent(val event: String, val id: String?, val data: String)

/**
 * 按行读 SSE（照 HTML 标准的规矩）：空行结束一条；`:` 开头的是注释（主站的保活）；`data` 可以有多行；
 * 字段名后面的冒号后如果有一个空格，去掉它；`id` 里有 NUL 的不算。
 */
class SseParser {
    private var event: String? = null
    private var id: String? = null
    private val data = StringBuilder()
    private var hasData = false

    /** 读一行（不带换行符）；读完一条时返回它。 */
    fun line(line: String): SseEvent? {
        if (line.isEmpty()) return dispatch()
        if (line.startsWith(':')) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(' ')) value = value.substring(1)
        when (field) {
            "event" -> event = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            }
            "id" -> if ('\u0000' !in value) id = value
        }
        return null
    }

    private fun dispatch(): SseEvent? {
        val result = if (hasData) SseEvent(event ?: "message", id, data.toString()) else null
        event = null
        id = null
        data.clear()
        hasData = false
        return result
    }
}

/** 事件流不再重连的原因：登录失效（设备被退出了），或者会话不在了。 */
class EventStreamClosed(val status: Int, val error: ApiError?) : Exception("event stream closed: HTTP $status")

/** 第 [attempt] 次重连前等多久：1、2、4、8、16 秒，之后每 30 秒一次。连上以后从头算。 */
fun reconnectDelay(attempt: Int): Long = minOf(30_000L, 1_000L shl minOf(attempt, 5))

/** 主站每 25 秒发一次保活，超过这么久什么都没收到就当作断了，重连。 */
private const val STREAM_READ_TIMEOUT_SECONDS = 75L

/**
 * 订阅主站的一条事件流（#204，会话事件 `/api/sessions/{id}/events` 这类），断线自动重连，带上最后一个序号
 * （`Last-Event-ID`），主站从它后面接着补发，不漏也不重复。
 *
 * - 401（登录失效）、403、404（会话不在了）时不再重连，流以 [EventStreamClosed] 结束；
 * - 连不上、5xx、读超时都等一会儿再连（[reconnectDelay]）；
 * - 不再收集时马上断开连接。
 */
fun eventStream(
    http: OkHttpClient,
    url: HttpUrl,
    lastEventId: String? = null,
    wait: suspend (Long) -> Unit = { delay(it) },
): Flow<SseEvent> = channelFlow {
    val current = AtomicReference<Call?>()
    val client = http.newBuilder().readTimeout(STREAM_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS).build()
    launch(Dispatchers.IO) { readLoop(client, url, lastEventId, current, wait) }
    try {
        awaitCancellation()
    } finally {
        // 读是阻塞的，取消协程叫不醒它：直接断开连接
        current.get()?.cancel()
    }
}

private suspend fun ProducerScope<SseEvent>.readLoop(
    client: OkHttpClient,
    url: HttpUrl,
    start: String?,
    current: AtomicReference<Call?>,
    wait: suspend (Long) -> Unit,
) {
    var last = start
    var attempt = 0
    while (true) {
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .apply { last?.let { header("Last-Event-ID", it) } }
            .build()
        val call = client.newCall(request)
        current.set(call)
        try {
            call.execute().use { response ->
                if (response.code in setOf(401, 403, 404)) {
                    throw EventStreamClosed(response.code, response.toApiException().error)
                }
                if (!response.isSuccessful) throw response.toApiException()
                attempt = 0
                val parser = SseParser()
                val source = response.body.source()
                while (true) {
                    val line = source.readUtf8Line() ?: break
                    val event = parser.line(line) ?: continue
                    if (event.id != null) last = event.id
                    send(event)
                }
            }
        } catch (_: IOException) {
            // 断了、读超时、5xx：下面等一会儿重连
        }
        currentCoroutineContext().ensureActive()
        wait(reconnectDelay(attempt++))
    }
}
