package cn.seekcloud.app.net

import java.net.ServerSocket
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** 认一认主站（#204）：每一种失败都分得出来；HTTP 和自签证书要管理员确认，证书换了重新问。 */
class ServerProbeTest {
    private val server = MockWebServer()

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.close()

    private val health = """{"status":"ok","product":"seekcloud","minAppVersion":null,"database":"ok","time":"x"}"""

    private fun reply(code: Int = 200, body: String = health, type: String = "application/json") =
        server.enqueue(MockResponse.Builder().code(code).addHeader("content-type", type).body(body).build())

    private fun http() = ServerAddress(secure = false, host = server.hostName, port = server.port)

    private fun probe(address: ServerAddress, trust: ServerTrust = ServerTrust(allowCleartext = true), app: String = "0.1.0") =
        probeServer(address, trust, appVersion = app, userAgent = userAgent(app, 37))

    @Test
    fun connectsToSeekCloudAndSendsUserAgent() {
        reply()
        assertEquals(ProbeResult.Connected(null), probe(http()))
        val request = server.takeRequest()
        assertEquals("/api/health", request.url.encodedPath)
        assertEquals("SeekCloudAndroid/0.1.0 (Android API 37)", request.headers["User-Agent"])
    }

    @Test
    fun httpNeedsConsentBeforeAnyRequest() {
        assertEquals(ProbeResult.NeedsCleartextConsent, probe(http(), ServerTrust()))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun tellsWhenItIsNotSeekCloud() {
        reply(body = """{"status":"ok","product":"other"}""")
        assertEquals(ProbeResult.NotSeekCloud, probe(http()))
        reply(body = "<html>hello</html>", type = "text/html")
        assertEquals(ProbeResult.NotSeekCloud, probe(http()))
        reply(code = 404, body = "not found", type = "text/plain")
        assertEquals(ProbeResult.NotSeekCloud, probe(http()))
    }

    @Test
    fun seekCloudThatIsDownIsUnavailable() {
        reply(code = 503, body = health.replace("\"ok\"", "\"error\""))
        assertEquals(ProbeResult.Unavailable, probe(http()))
    }

    @Test
    fun asksForAnUpdateWhenTheAppIsTooOld() {
        reply(body = health.replace("\"minAppVersion\":null", "\"minAppVersion\":\"0.2.0\""))
        assertEquals(ProbeResult.AppTooOld("0.2.0"), probe(http(), app = "0.1.9"))
    }

    @Test
    fun unreachableWhenNothingListens() {
        val port = ServerSocket(0).use { it.localPort }
        assertEquals(ProbeResult.Unreachable, probe(ServerAddress(false, "127.0.0.1", port)))
    }

    @Test
    fun selfSignedCertificateNeedsConsentAndIsPinnedForThisServerOnly() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName(server.hostName).build()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory())
        val https = ServerAddress(secure = true, host = server.hostName, port = server.port)
        val fingerprint = cert.certificate.sha256Fingerprint()

        // 系统不信任：给出证书的指纹，等管理员确认
        val first = probe(https, ServerTrust())
        assertTrue("$first", first is ProbeResult.UntrustedCertificate)
        first as ProbeResult.UntrustedCertificate
        assertEquals(fingerprint, first.fingerprint)
        assertFalse(first.changed)

        // 钉住这一张以后连得上
        reply()
        assertEquals(ProbeResult.Connected(null), probe(https, ServerTrust(pinnedCertificate = fingerprint)))

        // 钉住的是别的证书（主站换了证书）：重新问，并说明证书变了
        val other = HeldCertificate.Builder().build().certificate.sha256Fingerprint()
        val changed = probe(https, ServerTrust(pinnedCertificate = other))
        assertTrue("$changed", changed is ProbeResult.UntrustedCertificate && changed.changed)
    }

    @Test
    fun pinnedCertificateIsAcceptedEvenIfItDoesNotNameTheHost() {
        // 自签证书常常不写访问用的主机名（比如用 IP 访问）：钉住的就是这一张时照样放行
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("seekcloud.internal").build()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory())
        val https = ServerAddress(secure = true, host = server.hostName, port = server.port)
        reply()
        assertEquals(
            ProbeResult.Connected(null),
            probe(https, ServerTrust(pinnedCertificate = cert.certificate.sha256Fingerprint())),
        )
    }

    @Test
    fun comparesVersionsNumerically() {
        assertFalse(isAppTooOld("0.1.0", null))
        assertFalse(isAppTooOld("0.10.0", "0.9.2"))
        assertTrue(isAppTooOld("0.9.2", "0.10.0"))
        assertFalse(isAppTooOld("1.0.0", "1.0"))
        assertTrue(isAppTooOld("1.0.0-rc.1", "1.0.1"))
        assertFalse(isAppTooOld("1.0.0", "weird"))
    }

    private fun redirect(location: String) =
        server.enqueue(MockResponse.Builder().code(301).addHeader("Location", location).body("moved").build())

    @Test
    fun httpRedirectToHttpsOnTheSameHostSwitchesToHttps() {
        redirect("https://${server.hostName}/api/health")
        assertEquals(ProbeResult.UseHttps(ServerAddress(true, server.hostName, null)), probe(http()))
        redirect("https://${server.hostName}:8443/api/health")
        assertEquals(ProbeResult.UseHttps(ServerAddress(true, server.hostName, 8443)), probe(http()))
    }

    @Test
    fun otherRedirectsAreNotFollowed() {
        redirect("https://elsewhere.example.com/api/health")
        assertEquals(ProbeResult.NotSeekCloud, probe(http()))
        redirect("http://${server.hostName}:1/api/health")
        assertEquals(ProbeResult.NotSeekCloud, probe(http()))
        assertEquals(2, server.requestCount)
    }
}
