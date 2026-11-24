package cn.seekcloud.app.net

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** 事件流（#204）：照 SSE 的规矩解析；断了带着最后一个序号重连；登录失效、会话不在时不再重连；不收了马上断开。 */
class EventStreamTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val waits = mutableListOf<Long>()

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.close()

    private fun stream(body: String) = server.enqueue(
        MockResponse.Builder().addHeader("content-type", "text/event-stream").body(body).build(),
    )

    private fun events(lastEventId: String? = null) =
        eventStream(http, server.url("/api/sessions/abc/events"), lastEventId, wait = { waits += it })

    @Test
    fun parsesEventsCommentsAndMultilineData() {
        val parser = SseParser()
        val lines = listOf(
            ": keepalive", "",
            "event: session", "id: 7", "data: {\"a\":1}", "",
            "event: delta", "data: line one", "data:line two", "",
            "data", "", // 只有字段名，数据是空的，也是一条
            "id: 8", "", // 没有 data：不算一条
            "retry: 1000", "unknown: x", "data: x", "",
        )
        val out = lines.mapNotNull { parser.line(it) }
        assertEquals(
            listOf(
                SseEvent("session", "7", "{\"a\":1}"),
                SseEvent("delta", null, "line one\nline two"),
                SseEvent("message", null, ""),
                SseEvent("message", null, "x"),
            ),
            out,
        )
    }

    @Test
    fun reconnectsWithTheLastSequenceNumber() = runBlocking {
        stream("event: session\nid: 1\ndata: a\n\nevent: delta\ndata: live\n\nevent: session\nid: 2\ndata: b\n\n")
        // 第二次连上之前先回一次 503：照样重连
        server.enqueue(MockResponse.Builder().code(503).body("{\"error\":{\"code\":\"internal_error\",\"message\":\"x\"}}").build())
        stream("event: session\nid: 3\ndata: c\n\n")
        val got = withTimeout(10_000) { events("0").take(4).toList() }
        assertEquals(listOf("a", "live", "b", "c"), got.map { it.data })

        assertEquals("0", server.takeRequest().headers["Last-Event-ID"])
        // 逐字输出没有序号，不改"最后一个序号"
        assertEquals("2", server.takeRequest().headers["Last-Event-ID"])
        assertEquals("2", server.takeRequest().headers["Last-Event-ID"])
        // 503 不算连上：第二次等得更久
        assertEquals(listOf(1_000L, 2_000L), waits)
    }

    @Test
    fun startsWithoutLastEventIdWhenNothingWasSeen() = runBlocking {
        stream("id: 1\ndata: a\n\n")
        withTimeout(10_000) { events().take(1).toList() }
        val request = server.takeRequest()
        assertNull(request.headers["Last-Event-ID"])
        assertEquals("text/event-stream", request.headers["Accept"])
    }

    @Test
    fun stopsWhenTheLoginIsGone() = runBlocking {
        server.enqueue(
            MockResponse.Builder().code(401)
                .body("{\"error\":{\"code\":\"unauthorized\",\"message\":\"请先登录\"}}").build(),
        )
        try {
            withTimeout(10_000) { events().toList() }
            fail("should stop")
        } catch (e: EventStreamClosed) {
            assertEquals(401, e.status)
            assertEquals("unauthorized", e.error?.code)
        }
        assertEquals(1, server.requestCount)
        assertEquals(emptyList<Long>(), waits)
    }

    @Test
    fun stopsWhenTheSessionIsGone() = runBlocking {
        server.enqueue(MockResponse.Builder().code(404).body("{}").build())
        try {
            withTimeout(10_000) { events().toList() }
            fail("should stop")
        } catch (e: EventStreamClosed) {
            assertEquals(404, e.status)
        }
    }

    @Test
    fun cancellingClosesTheConnectionRightAway() = runBlocking {
        // 第一条之后的保活慢慢地发，连接一直开着
        val keepalive = ": keepalive\n\n".repeat(1_000)
        server.enqueue(
            MockResponse.Builder()
                .addHeader("content-type", "text/event-stream")
                .body("id: 1\ndata: a\n\n$keepalive")
                .throttleBody(16, 1, TimeUnit.SECONDS)
                .build(),
        )
        val started = System.nanoTime()
        val got = withTimeout(10_000) { events().take(1).toList() }
        assertEquals("a", got.single().data)
        assertTrue(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(8))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun backoffGrowsAndIsCapped() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), (0..6).map(::reconnectDelay))
    }
}
