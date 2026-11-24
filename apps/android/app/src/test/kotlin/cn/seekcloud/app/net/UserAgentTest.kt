package cn.seekcloud.app.net

import org.junit.Assert.assertEquals
import org.junit.Test

class UserAgentTest {
    /** 带上 App 的标记、版本和系统版本。 */
    @Test
    fun includesAppMarkerVersionAndSystemVersion() {
        assertEquals("SeekCloudAndroid/0.1.0 (Android API 37)", userAgent("0.1.0", 37))
    }
}
