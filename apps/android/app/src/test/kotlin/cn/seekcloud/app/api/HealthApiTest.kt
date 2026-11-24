package cn.seekcloud.app.api

import cn.seekcloud.app.api.apis.DefaultApi
import cn.seekcloud.app.api.models.ApiHealthGet200Response
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** 生成的接口代码（#203）照主站的接口文档说话：调 /api/health，读出产品名和要求的最低 App 版本。 */
class HealthApiTest {
    private val server = MockWebServer()

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.close()

    private fun api() = DefaultApi(basePath = server.url("/").toString().trimEnd('/'))

    // 测试方法名只用英文：Gradle 的测试报告按方法名建文件，系统编码不是 UTF-8 时中文文件名建不了
    @Test
    fun readsProductStatusAndMinimumAppVersion() {
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .addHeader("content-type", "application/json")
                .body(
                    """{"status":"ok","product":"seekcloud","minAppVersion":"0.1.0","database":"ok","time":"2026-11-24T00:00:00.000Z"}""",
                )
                .build(),
        )

        val health = api().apiHealthGet()

        assertEquals(ApiHealthGet200Response.Product.SEEKCLOUD, health.product)
        assertEquals(ApiHealthGet200Response.Status.OK, health.status)
        assertEquals("0.1.0", health.minAppVersion)
        assertNull("没登录时主站不给版本号", health.version)
        assertEquals("/api/health", server.takeRequest().url.encodedPath)
    }
}
