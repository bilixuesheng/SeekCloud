package cn.seekcloud.app.connect

import cn.seekcloud.app.net.KeyValueStore
import cn.seekcloud.app.net.ProbeResult
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerStore
import cn.seekcloud.app.net.ServerTrust
import kotlinx.coroutines.runBlocking
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MemoryStore : KeyValueStore {
    val values = mutableMapOf<String, String>()
    override fun get(key: String) = values[key]
    override fun put(key: String, value: String) {
        values[key] = value
    }
}

/**
 * 连接的流程（#204）：每一种结果对上页面上的一种状态；管理员确认过的只放行问到的那一项，
 * 连上了才记下来；证书换了重新问，确认后记下新的那张。
 */
class ConnectorTest {
    private val store = ServerStore(MemoryStore())
    private val calls = mutableListOf<Pair<ServerAddress, ServerTrust>>()
    private var answers = ArrayDeque<ProbeResult>()
    private val connector = Connector(store) { address, trust ->
        calls += address to trust
        answers.removeFirst()
    }

    private fun answer(vararg results: ProbeResult) {
        answers = ArrayDeque(results.toList())
    }

    private val cert = HeldCertificate.Builder().build().certificate
    private val http = ServerAddress(false, "192.168.1.5", 8080)
    private val https = ServerAddress(true, "seekcloud.example.com", null)

    @Test
    fun invalidAddressNeverReachesTheNetwork() = runBlocking {
        assertEquals(ConnectState.Failed(Problem.Invalid), connector.connect("ftp://x"))
        assertEquals(ConnectState.Failed(Problem.Invalid), connector.connect("user:pw@host"))
        assertEquals(0, calls.size)
    }

    @Test
    fun connectedServerIsSavedAsCurrent() = runBlocking {
        answer(ProbeResult.Connected(null))
        val state = connector.connect(" seekcloud.example.com/s/abc ")
        assertEquals(ConnectState.Connected(https, SavedServer("https://seekcloud.example.com")), state)
        assertEquals(https to ServerTrust(), calls.single())
        assertEquals(SavedServer("https://seekcloud.example.com"), store.current())
    }

    @Test
    fun httpAsksOnceAndRemembersTheConsentForThatAddressOnly() = runBlocking {
        answer(ProbeResult.NeedsCleartextConsent, ProbeResult.Connected(null))
        val ask = connector.connect("http://192.168.1.5:8080") as ConnectState.AskCleartext
        assertNull(store.current())
        val state = connector.allowCleartext(ask)
        assertEquals(ServerTrust(allowCleartext = true), calls.last().second)
        assertEquals(SavedServer("http://192.168.1.5:8080", allowCleartext = true), (state as ConnectState.Connected).server)

        // 再连同一个地址不再问；换个端口是另一个地址，要重新问
        answer(ProbeResult.Connected(null), ProbeResult.NeedsCleartextConsent)
        assertEquals(ConnectState.Connected(http, store.current()!!), connector.connect("http://192.168.1.5:8080"))
        assertEquals(ServerTrust(allowCleartext = true), calls.last().second)
        assert(connector.connect("http://192.168.1.5:9090") is ConnectState.AskCleartext)
        assertEquals(ServerTrust(), calls.last().second)
    }

    @Test
    fun declinedConsentSavesNothing() = runBlocking {
        answer(ProbeResult.NeedsCleartextConsent)
        connector.connect("http://192.168.1.5:8080")
        assertEquals(emptyList<SavedServer>(), store.servers())
    }

    @Test
    fun selfSignedCertificateIsPinnedAfterConsent() = runBlocking {
        answer(ProbeResult.UntrustedCertificate(cert, "AA:BB", changed = false), ProbeResult.Connected(null))
        val ask = connector.connect("seekcloud.example.com") as ConnectState.AskCertificate
        assertEquals(ConnectState.AskCertificate(https, ServerTrust(), "AA:BB", changed = false), ask)
        connector.trustCertificate(ask)
        assertEquals(ServerTrust(pinnedCertificate = "AA:BB"), calls.last().second)
        assertEquals("AA:BB", store.current()?.pinnedCertificate)
    }

    @Test
    fun changedCertificateAsksAgainAndReplacesThePin() = runBlocking {
        store.save(SavedServer("https://seekcloud.example.com", pinnedCertificate = "AA:BB"))
        answer(ProbeResult.UntrustedCertificate(cert, "CC:DD", changed = true), ProbeResult.Connected(null))
        val ask = connector.connect("seekcloud.example.com") as ConnectState.AskCertificate
        // 先拿以前钉住的证书去连
        assertEquals(ServerTrust(pinnedCertificate = "AA:BB"), calls.first().second)
        assertEquals(true, ask.changed)
        assertEquals("CC:DD", ask.fingerprint)
        connector.trustCertificate(ask)
        assertEquals(ServerTrust(pinnedCertificate = "CC:DD"), calls.last().second)
        assertEquals(listOf(SavedServer("https://seekcloud.example.com", pinnedCertificate = "CC:DD")), store.servers())
    }

    @Test
    fun httpThatRedirectsToHttpsIsSavedAsHttps() = runBlocking {
        answer(ProbeResult.NeedsCleartextConsent, ProbeResult.UseHttps(https), ProbeResult.Connected(null))
        val ask = connector.connect("http://seekcloud.example.com") as ConnectState.AskCleartext
        val state = connector.allowCleartext(ask) as ConnectState.Connected
        // 升到 https 以后不带明文的放行
        assertEquals(https to ServerTrust(), calls.last())
        assertEquals(SavedServer("https://seekcloud.example.com"), state.server)
        assertEquals(listOf(state.server), store.servers())
    }

    @Test
    fun everyFailureHasItsOwnState() = runBlocking {
        val cases = mapOf(
            ProbeResult.Unreachable to Problem.Unreachable,
            ProbeResult.NotSeekCloud to Problem.NotSeekCloud,
            ProbeResult.Unavailable to Problem.Unavailable,
            ProbeResult.TlsFailure to Problem.TlsFailure,
            ProbeResult.AppTooOld("0.2.0") to Problem.AppTooOld("0.2.0"),
        )
        for ((result, problem) in cases) {
            answer(result)
            assertEquals(ConnectState.Failed(problem), connector.connect("seekcloud.example.com"))
        }
        assertEquals(emptyList<SavedServer>(), store.servers())
    }

    @Test
    fun unexpectedErrorsAreUnreachableInsteadOfACrash() = runBlocking {
        val failing = Connector(store) { _, _ -> throw IllegalStateException("boom") }
        assertEquals(ConnectState.Failed(Problem.Unreachable), failing.connect("seekcloud.example.com"))
    }

    @Test
    fun fingerprintIsShownEightBytesPerLine() {
        val fingerprint = (0 until 32).joinToString(":") { "%02X".format(it) }
        val lines = fingerprintLines(fingerprint).lines()
        assertEquals(4, lines.size)
        assertEquals("00:01:02:03:04:05:06:07", lines.first())
    }
}
