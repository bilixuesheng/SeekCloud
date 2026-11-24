package cn.seekcloud.app.net

import cn.seekcloud.app.R
import java.io.IOException
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 报错（#204）：读主站的格式；认得的 code 用 App 的文案，不认得的用主站给的 message，和网页一样。 */
class ApiErrorTest {
    private val texts = object : ErrorTexts {
        override fun string(id: Int) = when (id) {
            R.string.error_session_not_found -> "session gone"
            R.string.error_invalid_request -> ""
            R.string.error_request_failed -> "request failed"
            R.string.error_network -> "network"
            else -> "string#$id"
        }

        override fun plural(id: Int, count: Int) = "plural#$id:$count"
    }

    @Test
    fun readsTheErrorFormat() {
        assertEquals(
            ApiError("session_not_found", "会话不存在"),
            parseApiError("""{"error":{"code":"session_not_found","message":"会话不存在","extra":1}}"""),
        )
        assertNull(parseApiError("<html>502 Bad Gateway</html>"))
        assertNull(parseApiError("""{"ok":true}"""))
    }

    @Test
    fun knownCodesUseTheCatalogAndUnknownOnesTheMessage() {
        assertEquals("session gone", errorText(ApiError("session_not_found", "x"), null, texts))
        assertEquals("server says", errorText(ApiError("something_new", "server says"), null, texts))
        // 目录里写成空的：用主站给的，它带着具体哪一项不对
        assertEquals("field x is bad", errorText(ApiError("invalid_request", "field x is bad"), null, texts))
    }

    @Test
    fun rateLimitedUsesRetryAfterWhenGiven() {
        val error = ApiError("rate_limited", "操作过于频繁")
        assertEquals("plural#${R.plurals.error_rate_limited}:30", errorText(error, 30, texts))
        assertEquals("操作过于频繁", errorText(error, null, texts))
    }

    @Test
    fun failuresWithoutAnErrorBodyAreGeneric() {
        assertEquals("request failed", failureText(ApiException(502, null), texts))
        assertEquals("network", failureText(IOException("reset"), texts))
        assertEquals("session gone", failureText(ApiException(404, ApiError("session_not_found", "x")), texts))
    }

    @Test
    fun readsErrorResponsesFromTheServer() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(
                MockResponse.Builder().code(429).addHeader("Retry-After", "12")
                    .body("""{"error":{"code":"rate_limited","message":"x"}}""").build(),
            )
            val client = serverClient(ServerAddress(false, server.hostName, server.port), ServerTrust(allowCleartext = true), "ua")
            val e = client.http.newCall(Request.Builder().url(server.url("/api/auth/login")).build()).execute().use {
                it.toApiException()
            }
            assertEquals(429, e.status)
            assertEquals("rate_limited", e.error?.code)
            assertEquals(12, e.retryAfter)
        }
    }

    @Test
    fun sendsTheDeviceTokenOnlyWhenThereIsOne() {
        MockWebServer().use { server ->
            server.start()
            repeat(2) { server.enqueue(MockResponse.Builder().body("{}").build()) }
            var token: String? = null
            val client = serverClient(
                ServerAddress(false, server.hostName, server.port),
                ServerTrust(allowCleartext = true),
                "ua",
                token = { token },
            )
            val call = { client.http.newCall(Request.Builder().url(server.url("/api/sessions")).build()).execute().close() }
            call()
            assertNull(server.takeRequest().headers["Authorization"])
            token = "abc"
            call()
            assertEquals("Bearer abc", server.takeRequest().headers["Authorization"])
        }
    }
}
