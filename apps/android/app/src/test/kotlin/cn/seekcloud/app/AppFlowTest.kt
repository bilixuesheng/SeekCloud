package cn.seekcloud.app

import cn.seekcloud.app.auth.Auth
import cn.seekcloud.app.auth.LoginResult
import cn.seekcloud.app.auth.Me
import cn.seekcloud.app.auth.SecretCipher
import cn.seekcloud.app.auth.TokenStore
import cn.seekcloud.app.connect.MemoryStore
import cn.seekcloud.app.connect.Problem
import cn.seekcloud.app.net.ApiError
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ProbeResult
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerStore
import cn.seekcloud.app.net.ServerTrust
import java.io.IOException
import kotlinx.coroutines.runBlocking
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 把字节倒过来当"加密"：测的是流程，不是密码学。 */
private object ReverseCipher : SecretCipher {
    override fun encrypt(plain: ByteArray) = plain.reversedArray()
    override fun decrypt(sealed: ByteArray) = sealed.reversedArray()
}

/** 假的主站：每台按地址给一个结果，令牌认不认由 [validTokens] 定。 */
private class FakeSite : ServerApis {
    var probe: ProbeResult = ProbeResult.Connected(null)
    val validTokens = mutableSetOf<String>()
    var loginReply: LoginResult = LoginResult.Token("t1")
    var meFailure: Exception? = null
    var setupRequired = false
    val loggedOut = mutableListOf<String>()
    val deviceNames = mutableListOf<String>()

    override suspend fun probe(address: ServerAddress, trust: ServerTrust) = probe

    override fun auth(server: SavedServer, token: String?) = object : Auth {
        override fun login(password: String, deviceName: String): LoginResult {
            deviceNames += deviceName
            if (password != "right") throw ApiException(400, ApiError("wrong_password", "密码错误"))
            (loginReply as? LoginResult.Token)?.let { validTokens += it.token }
            return loginReply
        }

        override fun verify(pendingToken: String, code: String): LoginResult {
            if (code != "123456") throw ApiException(400, ApiError("wrong_code", "验证码错误"))
            validTokens += "t2"
            return LoginResult.Token("t2")
        }

        override fun me(): Me {
            meFailure?.let { throw it }
            if (token == null || token !in validTokens) {
                val code = if (setupRequired) "setup_required" else "unauthorized"
                throw ApiException(401, ApiError(code, "x"))
            }
            return Me("管理员")
        }

        override fun logout() {
            token?.let { loggedOut += it; validTokens -= it }
        }
    }
}

/**
 * App 在各页之间怎么走（#205）：打开时去哪一页、登录和两步验证、令牌被吊销回登录页、
 * 退出、换服务器、删服务器、改地址以后登录状态保留。
 */
class AppFlowTest {
    private var next = 0
    private val servers = ServerStore(MemoryStore()) { "s${++next}" }
    private val tokenMemory = MemoryStore()
    private val tokens = TokenStore(tokenMemory, ReverseCipher)
    private val site = FakeSite()
    private val flow = AppFlow(servers, tokens, site, deviceName = "Google Pixel 8")

    private val a = ServerAddress(true, "a.example.com", null)
    private val b = ServerAddress(true, "b.example.com", null)

    @Test
    fun noServerOpensTheConnectPage() = runBlocking {
        assertEquals(Screen.Connect(), flow.start())
    }

    @Test
    fun savedServerWithoutTokenOpensLogin() = runBlocking {
        val server = servers.save(a, ServerTrust())
        assertEquals(Screen.Login(server), flow.start())
    }

    @Test
    fun loginStoresTheTokenEncryptedAndOpensHome() = runBlocking {
        val server = servers.save(a, ServerTrust())
        val step = flow.login(server, "right") as LoginStep.Done
        assertEquals(Screen.Home(server, "管理员"), step.screen)
        assertEquals("t1", tokens.get(server.id))
        // 存下来的不是明文
        assertFalse(tokenMemory.values.values.any { "t1" in it })
        assertEquals(listOf("Google Pixel 8"), site.deviceNames)
        // 再打开直接进首页
        assertEquals(Screen.Home(server, "管理员"), flow.start())
    }

    @Test
    fun wrongPasswordIsAnApiError() = runBlocking {
        val server = servers.save(a, ServerTrust())
        val error = runCatching { flow.login(server, "wrong") }.exceptionOrNull() as ApiException
        assertEquals("wrong_password", error.error?.code)
        assertNull(tokens.get(server.id))
    }

    @Test
    fun twoFactorAsksForACodeThenOpensHome() = runBlocking {
        val server = servers.save(a, ServerTrust())
        site.loginReply = LoginResult.SecondFactor("pending")
        val step = flow.login(server, "right") as LoginStep.SecondFactor
        assertNull(tokens.get(server.id))
        val error = runCatching { flow.verify(server, step.pendingToken, "000000") }.exceptionOrNull() as ApiException
        assertEquals("wrong_code", error.error?.code)
        val done = flow.verify(server, step.pendingToken, "123456") as LoginStep.Done
        assertEquals(Screen.Home(server, "管理员"), done.screen)
        assertEquals("t2", tokens.get(server.id))
    }

    @Test
    fun revokedTokenGoesBackToLoginAndSaysSo() = runBlocking {
        val server = servers.save(a, ServerTrust())
        flow.login(server, "right")
        // 管理员在网页上退出了这台设备
        site.validTokens.clear()
        assertEquals(Screen.Login(server, signedOut = true), flow.start())
        assertNull(tokens.get(server.id))
    }

    @Test
    fun unreachableServerOpensTheOfflinePage() = runBlocking {
        val server = servers.save(a, ServerTrust())
        for ((result, problem) in listOf(
            ProbeResult.Unreachable to Problem.Unreachable,
            ProbeResult.NotSeekCloud to Problem.NotSeekCloud,
            ProbeResult.Unavailable to Problem.Unavailable,
            ProbeResult.TlsFailure to Problem.TlsFailure,
        )) {
            site.probe = result
            assertEquals(Screen.Offline(server, problem), flow.start())
        }
    }

    @Test
    fun networkFailureWhileCheckingTheTokenKeepsTheToken() = runBlocking {
        val server = servers.save(a, ServerTrust())
        flow.login(server, "right")
        site.meFailure = IOException("reset")
        assertEquals(Screen.Offline(server, Problem.Unreachable), flow.start())
        assertEquals("t1", tokens.get(server.id))
    }

    @Test
    fun changedCertificateOrHttpsUpgradeGoesBackToConnectForThatServer() = runBlocking {
        val server = servers.save(a, ServerTrust(pinnedCertificate = "AA"))
        val cert = HeldCertificate.Builder().build().certificate
        site.probe = ProbeResult.UntrustedCertificate(cert, "BB", changed = true)
        assertEquals(Screen.Connect(editing = server, autoConnect = true), flow.start())
        site.probe = ProbeResult.UseHttps(b)
        assertEquals(Screen.Connect(editing = server, autoConnect = true), flow.start())
    }

    @Test
    fun tooOldAppAsksForAnUpdate() = runBlocking {
        val server = servers.save(a, ServerTrust())
        site.probe = ProbeResult.AppTooOld("0.2.0")
        assertEquals(Screen.UpdateRequired(server, "0.2.0"), flow.start())
    }

    @Test
    fun setupRequiredIsDetected() = runBlocking {
        val server = servers.save(a, ServerTrust())
        assertFalse(flow.needsSetup(server))
        site.setupRequired = true
        assertTrue(flow.needsSetup(server))
        site.meFailure = IOException("reset")
        assertFalse(flow.needsSetup(server))
    }

    @Test
    fun logoutRevokesOnTheServerAndForgetsTheToken() = runBlocking {
        val server = servers.save(a, ServerTrust())
        flow.login(server, "right")
        assertEquals(Screen.Login(server), flow.logout(server))
        assertEquals(listOf("t1"), site.loggedOut)
        assertNull(tokens.get(server.id))
    }

    @Test
    fun logoutWorksOffline() = runBlocking {
        val failing = AppFlow(servers, tokens, object : ServerApis {
            override suspend fun probe(address: ServerAddress, trust: ServerTrust) = ProbeResult.Unreachable
            override fun auth(server: SavedServer, token: String?) = object : Auth {
                override fun login(password: String, deviceName: String) = throw IOException()
                override fun verify(pendingToken: String, code: String) = throw IOException()
                override fun me() = throw IOException()
                override fun logout() = throw IOException("offline")
            }
        }, "x")
        val server = servers.save(a, ServerTrust())
        tokens.put(server.id, "t1")
        assertEquals(Screen.Login(server), failing.logout(server))
        assertNull(tokens.get(server.id))
    }

    @Test
    fun serversKeepTheirOwnLoginState() = runBlocking {
        val first = servers.save(a, ServerTrust())
        flow.login(first, "right")
        val second = servers.save(b, ServerTrust())
        assertEquals(Screen.Login(second), flow.start())
        assertEquals(Screen.Home(first, "管理员"), flow.switchTo(first))
        assertEquals(first.id, servers.current()?.id)
        assertEquals(Screen.Login(second), flow.switchTo(second))
        assertTrue(flow.hasToken(first))
        assertFalse(flow.hasToken(second))
    }

    @Test
    fun removingTheCurrentServerOpensTheNextOne() = runBlocking {
        val first = servers.save(a, ServerTrust())
        flow.login(first, "right")
        val second = servers.save(b, ServerTrust())
        // 删的不是现在用的：留在列表页
        assertNull(flow.remove(first))
        assertEquals(listOf("t1"), site.loggedOut)
        assertNull(tokens.get(first.id))
        assertEquals(Screen.Connect(), flow.remove(second))
        assertEquals(emptyList<SavedServer>(), servers.servers())
    }

    @Test
    fun changingTheAddressKeepsTheLogin() = runBlocking {
        val server = servers.save(a, ServerTrust())
        flow.login(server, "right")
        // 出错页里改了地址，连上了新地址：还是这一台，令牌照用
        val (moved, merged) = servers.changeAddress(server.id, b, ServerTrust())
        assertEquals(Screen.Home(moved, "管理员"), flow.connected(moved, merged))
        assertEquals("t1", tokens.get(moved.id))
    }

    @Test
    fun mergedServersLoseTheirOwnToken() = runBlocking {
        val first = servers.save(a, ServerTrust())
        flow.login(first, "right")
        val second = servers.save(b, ServerTrust())
        tokens.put(second.id, "old")
        val (moved, merged) = servers.changeAddress(first.id, b, ServerTrust())
        assertEquals(second.id, merged)
        flow.connected(moved, merged)
        assertNull(tokens.get(second.id))
        assertEquals("t1", tokens.get(first.id))
    }

    @Test
    fun loginResultsDoNotPrintTheToken() {
        assertFalse("secret" in LoginResult.Token("secret").toString())
        assertFalse("secret" in LoginResult.SecondFactor("secret").toString())
        assertFalse("secret" in LoginStep.SecondFactor("secret").toString())
    }
}
