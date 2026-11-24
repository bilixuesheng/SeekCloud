package cn.seekcloud.app

import android.content.Context
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 界面测试（#205）：真的 App 连两台假主站（主站的 `pnpm app-test-server`，模拟器经 10.0.2.2 连到跑测试的机器），
 * 走连接、登录、退出、换服务器、令牌被吊销回登录页。CI 的 Android 工作流里的 ui 一项这样跑：
 *
 *     ./gradlew connectedDebugAndroidTest \
 *       -Pandroid.testInstrumentationRunnerArguments.siteA=http://10.0.2.2:端口A \
 *       -Pandroid.testInstrumentationRunnerArguments.siteB=http://10.0.2.2:端口B \
 *       -Pandroid.testInstrumentationRunnerArguments.password=管理员密码
 *
 * 没给这几个参数时跳过。
 */
@RunWith(AndroidJUnit4::class)
class AppUiTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private val args = InstrumentationRegistry.getArguments()
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val siteA: String = args.getString("siteA").orEmpty()
    private val siteB: String = args.getString("siteB").orEmpty()
    private val password: String = args.getString("password").orEmpty()
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun clean() {
        assumeTrue("needs siteA, siteB and password", siteA.isNotEmpty() && siteB.isNotEmpty() && password.isNotEmpty())
        // 每个测试从头开始：没有保存的主站、没有令牌
        for (name in listOf("servers", "tokens")) context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @After
    fun close() {
        scenario?.close()
    }

    private fun launch() {
        scenario?.close()
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    private fun s(id: Int, vararg args: Any): String = context.getString(id, *args)

    private fun waitFor(text: String, timeoutMs: Long = 20_000) {
        rule.waitUntil(timeoutMs) { rule.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
    }

    /** 页面上（不在弹窗里）的按钮：页面能滚动，先滚到它那里再点。 */
    private fun tap(text: String) {
        rule.onNode(hasText(text) and hasClickAction() and !hasAnyAncestor(isDialog()))
            .performScrollTo()
            .performClick()
    }

    /** 弹窗里的按钮。 */
    private fun tapInDialog(text: String) =
        rule.onNode(hasText(text) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()

    private fun type(text: String) = rule.onNode(hasSetTextAction()).performTextReplacement(text)

    /** 在"连接服务器"页连一台 http 的假主站：要确认"连接未加密"。 */
    private fun connect(site: String) {
        waitFor(s(R.string.connect_address))
        type(site)
        tap(s(R.string.connect_button))
        waitFor(s(R.string.connect_cleartext_confirm))
        tapInDialog(s(R.string.connect_cleartext_confirm))
        waitFor(s(R.string.login_password))
    }

    private fun signIn() {
        type(password)
        tap(s(R.string.login_button))
        waitFor(s(R.string.home_signed_in, HOST))
    }

    @Test
    fun connectSignInAndSignOut() {
        launch()
        connect(siteA)
        signIn()
        // 重新打开 App 还是登录着的
        launch()
        waitFor(s(R.string.home_signed_in, HOST))
        tap(s(R.string.sign_out))
        tapInDialog(s(R.string.sign_out))
        waitFor(s(R.string.login_password))
    }

    @Test
    fun wrongPasswordShowsTheError() {
        launch()
        connect(siteA)
        type("wrong-password")
        tap(s(R.string.login_button))
        waitFor(s(R.string.error_wrong_password))
    }

    @Test
    fun serversKeepTheirOwnSignIn() {
        launch()
        connect(siteA)
        signIn()
        tap(s(R.string.switch_server))
        waitFor(s(R.string.servers_add))
        tap(s(R.string.servers_add))
        connect(siteB)
        // B 还没登录；换回 A，A 还登录着
        tap(s(R.string.switch_server))
        waitFor(s(R.string.servers_add))
        rule.onNode(hasText("$siteA · ", substring = true) and hasClickAction()).performScrollTo().performClick()
        waitFor(s(R.string.home_signed_in, HOST))
        tap(s(R.string.switch_server))
        waitFor(s(R.string.servers_add))
        rule.onNode(hasText("$siteB · ${s(R.string.servers_signed_out)}", substring = true)).assertExists()
        rule.onNode(hasText("$siteA · ${s(R.string.servers_current)}", substring = true)).assertExists()
    }

    @Test
    fun revokedDeviceGoesBackToSignIn() {
        launch()
        connect(siteA)
        signIn()
        scenario?.close()
        scenario = null
        // 管理员在别处（这里是另一台"设备"）把这台退出了
        revokeOtherAppDevices(siteA)
        launch()
        waitFor(s(R.string.login_signed_out))
    }

    /** 以另一台设备登录，把别的 App 设备都退出（就是网页上设置 → 账户 → 登录设备里点"退出"）。 */
    private fun revokeOtherAppDevices(site: String) {
        val http = OkHttpClient()
        val json = "application/json".toMediaType()
        val login = """{"password":"$password","client":"app","deviceName":"UI test"}""".toRequestBody(json)
        val token = http.newCall(Request.Builder().url("$site/api/auth/login").post(login).build()).execute().use {
            Json.parseToJsonElement(it.body.string()).jsonObject.getValue("token").jsonPrimitive.content
        }
        val auth = { b: Request.Builder -> b.header("Authorization", "Bearer $token") }
        val devices = http.newCall(auth(Request.Builder().url("$site/api/auth/devices")).build()).execute().use {
            Json.parseToJsonElement(it.body.string()).jsonObject.getValue("devices").jsonArray
        }
        for (device in devices.map { it.jsonObject }) {
            val current = device.getValue("current").jsonPrimitive.content == "true"
            if (current || device.getValue("client").jsonPrimitive.content != "app") continue
            val id = device.getValue("id").jsonPrimitive.content
            http.newCall(auth(Request.Builder().url("$site/api/auth/devices/$id")).delete().build()).execute().close()
        }
    }

    private companion object {
        /** 模拟器里看到的跑测试的机器。 */
        const val HOST = "10.0.2.2"
    }
}

private operator fun SemanticsMatcher.not() = SemanticsMatcher("NOT (${this.description})") { !this.matches(it) }
