package cn.seekcloud.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 地址的规整（#204）。 */
class ServerAddressTest {
    private fun origin(input: String) = ServerAddress.parse(input)?.origin

    @Test
    fun addsHttpsAndDropsPathQueryAndFragment() {
        assertEquals("https://seekcloud.example.com", origin("seekcloud.example.com"))
        assertEquals("https://example.com", origin("  https://Example.COM/s/abc?x=1#top  "))
        assertEquals("https://example.com", origin("HTTPS://example.com/"))
    }

    @Test
    fun keepsHttpPortsIpAndIpv6() {
        val http = ServerAddress.parse("http://192.168.1.5:8080/login")!!
        assertEquals(false, http.secure)
        assertEquals("http://192.168.1.5:8080", http.origin)
        assertEquals("https://example.com:8443", origin("example.com:8443"))
        assertEquals("https://[::1]:8443", origin("[::1]:8443"))
        assertEquals("https://10.0.0.2", origin("10.0.0.2"))
    }

    @Test
    fun dropsDefaultPortsAndConvertsInternationalNames() {
        assertEquals("https://example.com", origin("example.com:443"))
        assertEquals("http://example.com", origin("http://example.com:80"))
        assertEquals("https://xn--fsqu00a.xn--0zwm56d", origin("例子.测试"))
    }

    @Test
    fun rejectsOtherSchemesCredentialsAndGarbage() {
        for (bad in listOf("", "   ", "ftp://example.com", "https://", "a b.com", "https://user:pw@example.com", "javascript:alert(1)")) {
            assertNull(bad, ServerAddress.parse(bad))
        }
    }
}
