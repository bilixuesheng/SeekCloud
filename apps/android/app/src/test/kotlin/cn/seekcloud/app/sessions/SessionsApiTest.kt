package cn.seekcloud.app.sessions

import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerTrust
import cn.seekcloud.app.net.serverClient
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/** 会话菜单的接口（#124）：路径和请求体和网页的一样，带着设备令牌；出错时带主站的报错。 */
class SessionsApiTest {
    private val server = MockWebServer()

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.close()

    private val api by lazy {
        SessionsApi(
            serverClient(ServerAddress(false, server.hostName, server.port), ServerTrust(allowCleartext = true), "ua", token = { "tok" }),
        )
    }

    private fun ok(body: String = "{}") = server.enqueue(MockResponse.Builder().body(body).build())

    private fun next(): Pair<String, String> {
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("Bearer tok", request.headers["Authorization"])
        return request.url.encodedPath to request.body!!.utf8()
    }

    @Test
    fun eachActionPostsWhatTheWebPosts() {
        repeat(9) { ok() }
        api.rename("abc", "  新标题 ")
        assertEquals("/api/sessions/abc/rename" to """{"title":"新标题"}""", next())
        api.setPinned("abc", true)
        assertEquals("/api/sessions/abc/pin" to """{"pinned":true}""", next())
        api.setUnread("abc", false)
        assertEquals("/api/sessions/abc/read" to """{"unread":false}""", next())
        api.archive("abc")
        assertEquals("/api/sessions/abc/archive" to "{}", next())
        api.unarchive("abc")
        assertEquals("/api/sessions/abc/unarchive" to "{}", next())
        api.delete("abc")
        assertEquals("/api/sessions/abc/delete" to "{}", next())
        api.moveToGroup("abc", "g1")
        assertEquals("/api/sessions/abc/place" to """{"section":"group","groupId":"g1","after":null}""", next())
        api.moveToGroup("abc", null)
        assertEquals("/api/sessions/abc/place" to """{"section":"recent","after":null}""", next())
    }

    @Test
    fun createGroupReturnsItsId() {
        ok("""{"id":"g9","name":"Backend","sortKey":3}""")
        assertEquals("g9", api.createGroup(" Backend "))
        assertEquals("/api/session-groups" to """{"name":"Backend"}""", next())
    }

    @Test
    fun errorsCarryTheServerCode() {
        server.enqueue(
            MockResponse.Builder().code(409)
                .body("""{"error":{"code":"session_archived","message":"已归档的会话不能置顶"}}""").build(),
        )
        val e = runCatching { api.setPinned("abc", true) }.exceptionOrNull() as ApiException
        assertEquals("session_archived", e.error?.code)
    }
}
