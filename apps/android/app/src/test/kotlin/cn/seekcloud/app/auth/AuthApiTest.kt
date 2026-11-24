package cn.seekcloud.app.auth

import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerTrust
import cn.seekcloud.app.net.serverClient
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** 登录相关的接口（#205）：两种成功、报错、令牌放在 Authorization 里、回的不是 JSON 时不崩。 */
class AuthApiTest {
    private val server = MockWebServer()

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.close()

    private fun api(token: String? = null) = AuthApi(
        serverClient(
            ServerAddress(false, server.hostName, server.port),
            ServerTrust(allowCleartext = true),
            "ua",
            token = { token },
        ),
    )

    private fun reply(code: Int, body: String) =
        server.enqueue(MockResponse.Builder().code(code).addHeader("content-type", "application/json").body(body).build())

    @Test
    fun loginSendsTheAppClientAndDeviceName() {
        reply(200, """{"token":"abc"}""")
        val result = api().login("pw", "Google Pixel 8") as LoginResult.Token
        assertEquals("abc", result.token)
        val request = server.takeRequest()
        assertEquals("/api/auth/login", request.url.encodedPath)
        assertEquals("""{"password":"pw","client":"app","deviceName":"Google Pixel 8"}""", request.body?.utf8())
        assertNull(request.headers["Authorization"])
    }

    @Test
    fun twoFactorReturnsThePendingToken() {
        reply(202, """{"secondFactor":"totp","pendingToken":"p","expiresAt":"x"}""")
        assertEquals("p", (api().login("pw", "d") as LoginResult.SecondFactor).pendingToken)
        reply(200, """{"token":"abc"}""")
        assertEquals("abc", (api().verify("p", " 123456 ") as LoginResult.Token).token)
        server.takeRequest()
        assertEquals("""{"pendingToken":"p","code":"123456"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun errorsCarryTheServerCode() {
        reply(400, """{"error":{"code":"wrong_password","message":"密码错误"}}""")
        val e = runCatching { api().login("x", "d") }.exceptionOrNull() as ApiException
        assertEquals(400, e.status)
        assertEquals("wrong_password", e.error?.code)
    }

    @Test
    fun meAndLogoutUseTheToken() {
        reply(200, """{"id":"u","githubLogin":null,"nickname":"管理员"}""")
        assertEquals("管理员", api("tok").me().nickname)
        assertEquals("Bearer tok", server.takeRequest().headers["Authorization"])
        server.enqueue(MockResponse.Builder().code(204).build())
        api("tok").logout()
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/auth/logout", request.url.encodedPath)
    }

    @Test
    fun notJsonIsAFailedRequestNotACrash() {
        server.enqueue(MockResponse.Builder().code(200).body("<html>portal</html>").build())
        val e = runCatching { api("tok").me() }.exceptionOrNull()
        assertTrue(e is ApiException)
        assertNull((e as ApiException).error)
    }
}
