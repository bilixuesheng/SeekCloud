package cn.seekcloud.app.net

import org.junit.Assert.assertEquals
import org.junit.Test

class UserAgentTest {
    @Test
    fun 带上_App_的标记_版本和系统版本() {
        assertEquals("SeekCloudAndroid/0.1.0 (Android API 37)", userAgent("0.1.0", 37))
    }
}
