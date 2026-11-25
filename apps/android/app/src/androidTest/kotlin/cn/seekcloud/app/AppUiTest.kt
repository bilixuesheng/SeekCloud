package cn.seekcloud.app

import android.content.Context
import android.content.pm.ActivityInfo
import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import android.icu.util.ULocale
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
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
import cn.seekcloud.app.settings.AppPreferences
import cn.seekcloud.app.ui.GLASS_TAB_BAR_TAG
import org.junit.After
import org.junit.Assert.assertTrue
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
        for (name in listOf("servers", "tokens", AppPreferences.FILE)) context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        // 照手指操作的样子：在触摸模式下点按钮不会拿到焦点（别的测试按过返回键会让模拟器离开触摸模式）
        InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
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

    /**
     * 出错时把当时整个界面的语义树写进失败信息：CI 的日志里只看得到失败信息，看不到截图。
     */
    private fun <T> explain(what: String, block: () -> T): T = try {
        block()
    } catch (e: Throwable) {
        val tree = runCatching { rule.onAllNodes(isRoot()).printToString(maxDepth = 40) }.getOrElse { "(no tree: $it)" }
        throw AssertionError("$what: ${e.message}\n--- UI tree ---\n$tree", e)
    }

    private fun waitFor(text: String, timeoutMs: Long = 20_000) = explain("waitFor \"$text\"") {
        rule.waitUntil(timeoutMs) { rule.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
    }

    /** 页面上（不在弹窗里）的按钮：页面能滚动时先滚到它那里再点。 */
    private fun tap(text: String, substring: Boolean = false) = explain("tap \"$text\"") {
        val node = rule.onNode(hasText(text, substring = substring) and hasClickAction() and !hasAnyAncestor(isDialog()))
        runCatching { node.performScrollTo() }
        node.performClick()
    }

    /** 底部弹层（会话菜单）里的一项：弹层是单独的窗口，不按"在不在弹窗里"区分。 */
    private fun tapSheet(text: String) = explain("tapSheet \"$text\"") {
        val node = rule.onNode(hasText(text) and hasClickAction())
        runCatching { node.performScrollTo() }
        node.performClick()
    }

    /** 会话列表右上角的"更多选项"里的一项。 */
    private fun menu(text: String) {
        rule.onNode(hasContentDescription(s(R.string.sessions_more))).performClick()
        waitFor(text)
        tap(text)
    }

    /** 弹窗里的按钮。 */
    private fun tapInDialog(text: String) = explain("tapInDialog \"$text\"") {
        rule.onNode(hasText(text) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
    }

    /** 往页面上唯一的输入框里填字：等它能输入了再填（正在连接、正在登录时输入框是禁用的）。 */
    private fun type(text: String) = explain("type") {
        rule.waitUntil(20_000) { rule.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isNotEmpty() }
        rule.onNode(hasSetTextAction()).performTextReplacement(text)
        hideKeyboard()
    }

    /**
     * 收起键盘：触摸模式下点输入框会弹出键盘，界面跟着重排；紧接着点下面的按钮时，按下和抬起之间按钮挪了位置，
     * 这一下就落空了。填完字先收起来，再点按钮。
     */
    private fun hideKeyboard() {
        scenario?.onActivity { activity ->
            activity.getSystemService(InputMethodManager::class.java)
                ?.hideSoftInputFromWindow(activity.window.decorView.windowToken, 0)
        }
        rule.waitForIdle()
    }

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
        waitForList()
    }

    /** 登录以后进会话列表：等顶栏的"搜索会话"出来（别的测试可能已经在这台假主站上发起过会话，不看列表是不是空的）。 */
    private fun waitForList() = explain("waitForList") {
        val search = s(R.string.sidebar_search)
        rule.waitUntil(20_000) { rule.onAllNodes(hasContentDescription(search)).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
    }

    @Test
    fun connectSignInAndSignOut() {
        launch()
        connect(siteA)
        signIn()
        // 重新打开 App 还是登录着的
        launch()
        waitForList()
        menu(s(R.string.sign_out))
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
        menu(s(R.string.switch_server))
        waitFor(s(R.string.servers_add))
        tap(s(R.string.servers_add))
        connect(siteB)
        // B 还没登录；换回 A，A 还登录着
        tap(s(R.string.switch_server))
        waitFor(s(R.string.servers_add))
        rule.onNode(hasText("$siteA · ", substring = true) and hasClickAction()).performScrollTo().performClick()
        waitForList()
        menu(s(R.string.switch_server))
        waitFor(s(R.string.servers_add))
        rule.onNode(hasText("$siteB · ${s(R.string.servers_signed_out)}", substring = true)).assertExists()
        rule.onNode(hasText("$siteA · ${s(R.string.servers_current)}", substring = true)).assertExists()
    }

    @Test
    fun newSessionsShowUpLive() {
        launch()
        connect(siteA)
        signIn()
        // 别处（网页上）发起一个会话：列表里马上出现，不用刷新
        val title = "Live session ${System.nanoTime()}"
        startSession(siteA, title)
        waitFor(title)
    }

    @Test
    fun startANewSession() {
        launch()
        connect(siteA)
        signIn()
        openNewSession()
        // 假主站没关联 GitHub：有关联的说明，只能不使用仓库
        waitFor(s(R.string.github_connect_title))
        val text = "New from the app ${System.nanoTime()}"
        type(text)
        tap(s(R.string.new_session_submit))
        // 发起以后直接进会话页：Agent 回复了（假主站默认回"收到。"）；返回列表，新会话在列表里
        waitFor(REPLY)
        rule.onNode(hasContentDescription(s(R.string.common_back)) and hasClickAction()).performClick()
        waitForList()
        waitFor(text)
    }

    @Test
    fun conversationShowsRepliesToolsAndChanges() {
        launch()
        connect(siteA)
        signIn()
        val files = listOf("src/app.ts", "src/health.ts", "test/health.test.ts", "README.md")
            .joinToString(",") { """{"path":"$it","additions":3,"deletions":1}""" }
        nextTurn(
            siteA,
            """{"events":[
              {"type":"message","text":"I will look at the project first."},
              {"type":"tool.call","callId":"c1","name":"Read","input":{"file_path":"src/app.ts"}},
              {"type":"tool.result","callId":"c1","output":"export {}","isError":false},
              {"type":"tool.call","callId":"c2","name":"Bash","input":{"command":"pnpm test"}},
              {"type":"tool.result","callId":"c2","output":"","isError":false},
              {"type":"message","text":"The health check is in place."},
              {"type":"workspace","repos":[{"fullName":"octo/app","head":"${"a".repeat(40)}","push":"pushed","files":[$files]}]}
            ]}""",
        )
        val title = "Conversation ${System.nanoTime()}"
        val shortId = startSession(siteA, title)
        // 回合结束时宿主机报的、对比基础分支的改动（改动面板用）
        diff(
            siteA,
            shortId,
            """[{"fullName":"octo/app","baseBranch":"main","base":"b","head":"h","files":[
              {"path":"README.md","additions":1,"deletions":1,"patch":"@@ -1,1 +1,1 @@\n-# Old title\n+# Health check"}
            ]}]""",
        )
        waitFor(title)
        tap(title)
        // 会话页：回复、两次工具调用合成一行、这一回合的改动卡片（列出三个，"查看全部"展开第四个）
        waitFor("The health check is in place.")
        // 两次工具调用合成一句（英文句首大写，所以找后半句"运行了 1 条命令"）
        val toolSummary = res.getQuantityString(R.plurals.tools_bash, 1, 1)
        waitFor(toolSummary)
        waitFor(res.getQuantityString(R.plurals.changes_changed_files, 4, 4))
        rule.onAllNodes(hasText("README.md")).assertCountEquals(0)
        // "查看全部"打开改动面板：逐行的 diff
        tap(s(R.string.changes_view_all))
        waitFor(s(R.string.changes_title))
        waitFor("+# Health check")
        waitFor("−# Old title")
        rule.onNode(hasContentDescription(s(R.string.common_close)) and hasClickAction()).performClick()
        rule.waitUntil(20_000) { rule.onAllNodes(hasText("+# Health check")).fetchSemanticsNodes().isEmpty() }

        // 置顶这个回合的回复：上方出现短标题，顶栏出现置顶列表，从列表跳到会话开头
        rule.onNode(hasContentDescription(s(R.string.session_pin)) and hasClickAction()).performScrollTo().performClick()
        waitForDescription(s(R.string.session_unpin))
        val pinned = res.getQuantityString(R.plurals.chat_pinned_messages, 1, 1)
        rule.onNode(hasContentDescription(pinned) and hasClickAction()).performClick()
        tapSheet(s(R.string.chat_session_start))
        // 点开工具调用：每一次的名字，再点开看输入
        tap(toolSummary, substring = true)
        waitFor("pnpm test")

        // 在会话页里接着发：Agent 回复
        type("And the tests?")
        rule.onNode(hasContentDescription(s(R.string.chat_send)) and hasClickAction()).performClick()
        waitFor(REPLY)
    }

    @Test
    fun markdownRepliesAreSafe() {
        launch()
        connect(siteA)
        signIn()
        val reply = listOf(
            "## Result",
            "[the docs](https://example.com/docs)",
            "```ts\\nconst answer = 42\\n```",
            "<b>raw html</b>",
            "![chart](https://images.example.net/leak.png?key=secret)",
        ).joinToString("\\n\\n")
        nextTurn(siteA, """{"events":[{"type":"message","text":"$reply"}]}""")
        val title = "Markdown ${System.nanoTime()}"
        startSession(siteA, title)
        waitFor(title)
        tap(title)
        // 标题、代码块照 Markdown 显示；原始 HTML 当文字
        waitFor("Result")
        waitFor("const answer = 42")
        waitFor("<b>raw html</b>")
        // 别的来源的图片不自动加载：先是一个"点击加载"的按钮
        waitFor(s(R.string.chat_image_blocked, "chart", "images.example.net"))
        // 链接先显示完整的地址确认，取消就不打开
        rule.onNode(hasText("the docs")).performClick()
        waitFor(s(R.string.link_open_body))
        waitFor("https://example.com/docs")
        tapInDialog(s(R.string.common_cancel))
        rule.waitUntil(20_000) { rule.onAllNodes(hasText(s(R.string.link_open_body))).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun sessionHeaderMenuInfoAndModel() {
        launch()
        connect(siteA)
        signIn()
        val title = "Header ${System.nanoTime()}"
        startSession(siteA, title)
        waitFor(title)
        tap(title)
        waitFor(REPLY)

        // 会话信息：状态、环境、仓库
        rule.onNode(hasContentDescription(s(R.string.session_info)) and hasClickAction()).performClick()
        waitFor(s(R.string.environment_default))
        waitFor(s(R.string.repo_no_repo))
        back()

        // 输入框下面的模型按钮：打开模型和思考强度的弹层
        val choose = s(R.string.model_choose, "").trimEnd()
        rule.onNode(hasContentDescription(choose, substring = true) and hasClickAction()).performClick()
        waitFor(s(R.string.model_dialog))
        back()

        // 点标题打开会话菜单：重命名以后顶栏跟着变
        val renamed = "$title renamed"
        rule.onNode(hasContentDescription(s(R.string.session_menu)) and hasClickAction()).performClick()
        waitFor(s(R.string.session_copy_link))
        tapSheet(s(R.string.common_rename))
        waitFor(s(R.string.session_title_label))
        explain("rename") { rule.onNode(hasSetTextAction() and hasText(title)).performTextReplacement(renamed) }
        tapSheet(s(R.string.common_save))
        waitFor(renamed)

        // 在会话页里删除：回到列表
        rule.onNode(hasContentDescription(s(R.string.session_menu)) and hasClickAction()).performClick()
        waitFor(s(R.string.session_copy_link))
        tapSheet(s(R.string.common_delete))
        tapSheet(s(R.string.session_delete_forever))
        waitForList()
        rule.waitUntil(20_000) { rule.onAllNodes(hasText(renamed)).fetchSemanticsNodes().isEmpty() }
    }

    /**
     * 系统的返回键（收起底部弹层、回到上一页）。按键会让模拟器离开触摸模式，之后点过的按钮会拿到焦点，
     * 有焦点时第一次按返回只清掉焦点；按完切回触摸模式，和手指操作时一样。
     */
    private fun back() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        instrumentation.setInTouchMode(true)
        rule.waitForIdle()
    }

    /**
     * 底栏的截图（#178）：两版玻璃效果各一张浅色、一张深色，再加一张退回毛玻璃的。截图用 shell 的 screencap
     * 存到 /data/local/tmp/seekcloud-screens（测试跑完 App 会被卸载，存在 App 自己的目录里会跟着删掉），CI 拉下来传成附件。
     */
    @Test
    fun glassTabBarScreenshots() {
        launch()
        connect(siteB)
        signIn()
        // 会话多到排进底栏下面，底栏才有内容可以折射（文字、未读的蓝点）
        val samples = (1..16).map { startSession(siteB, "Glass sample $it") }
        waitForSamples()
        shell("mkdir -p $SCREENS")
        try {
            for ((night, name) in listOf("no" to "light", "yes" to "dark")) {
                shell("cmd uimode night $night")
                for (style in listOf("Colorful", "Plain")) {
                    prefs().edit().putString(AppPreferences.GLASS, style).commit()
                    launch()
                    waitForSamples()
                    rule.waitForIdle()
                    Thread.sleep(1500)
                    shell("screencap -p $SCREENS/glass-${style.lowercase()}-$name.png")
                }
            }
            shell("cmd uimode night no")
            prefs().edit().putString(AppPreferences.GLASS, "Colorful").putString(AppPreferences.RENDER, "Frosted").commit()
            launch()
            waitForSamples()
            Thread.sleep(1500)
            shell("screencap -p $SCREENS/glass-frosted-light.png")
            // 设置里切换以后底栏马上换，不用重启 App
            prefs().edit().remove(AppPreferences.RENDER).commit()
            launch()
            waitForSamples()
            openSettings()
            tap(s(R.string.settings_section_general))
            waitFor(s(R.string.settings_glass))
            tap(s(R.string.settings_glass_plain))
            Thread.sleep(800)
            shell("screencap -p $SCREENS/settings-plain-light.png")

            // 按住、拖动、松手的录屏（#178 第二步）：两版玻璃各一段浅色、一段深色。CI 的模拟器关了动画，
            // 录的时候打开（App 按系统设置决定要不要鼓起），录完改回去
            val scale = shellOutput("settings get global animator_duration_scale").trim().ifEmpty { "1" }
            shell("settings put global animator_duration_scale 1")
            try {
                for ((night, name) in listOf("no" to "light", "yes" to "dark")) {
                    shell("cmd uimode night $night")
                    for (style in listOf("Colorful", "Plain")) {
                        prefs().edit().putString(AppPreferences.GLASS, style).commit()
                        launch()
                        waitForSamples()
                        recordPress("press-${style.lowercase()}-$name.mp4")
                    }
                }
            } finally {
                shell("settings put global animator_duration_scale ${if (scale == "null") "1" else scale}")
            }
        } finally {
            shell("cmd uimode night no")
            // 删掉这些会话：假主站是几个测试共用的，列表太长时别的测试新发起的会话会排到屏幕外面
            val token = appToken(siteB)
            for (id in samples) {
                val request = Request.Builder().url("$siteB/api/sessions/$id/delete").header("Authorization", "Bearer $token")
                    .post("{}".toRequestBody(JSON)).build()
                OkHttpClient().newCall(request).execute().close()
            }
        }
    }

    /** 等列表排满一屏（列表只画看得到的行，所以按行数等，不按哪一个）。 */
    private fun waitForSamples() = explain("waitForSamples") {
        rule.waitUntil(20_000) { rule.onAllNodes(hasText("Glass sample", substring = true)).fetchSemanticsNodes().size >= 10 }
        rule.waitForIdle()
    }

    private fun prefs() = context.getSharedPreferences(AppPreferences.FILE, Context.MODE_PRIVATE)

    /**
     * 一边录屏一边模拟手指操作底栏（#178）：按住第一项、慢慢拖到第三项再拖回第二项、松手，然后点一下第一项。
     * 测试里的动画只在测试时钟往前走时才动，所以录的时候关掉自动走，自己一帧一帧往前推（每帧之间真的等 16 毫秒），
     * 录下来接近真实的速度。手指的事件经 UiAutomation 直接发给系统，和真的触摸一样。
     */
    private fun recordPress(file: String) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val bar = rule.onNode(hasTestTag(GLASS_TAB_BAR_TAG)).fetchSemanticsNode().boundsInWindow
        val count = 3
        val inset = 4 * context.resources.displayMetrics.density
        val y = bar.center.y
        fun x(index: Float) = bar.left + inset + (bar.width - 2 * inset) * (index + 0.5f) / count
        val recording = automation.executeShellCommand("screenrecord --time-limit 12 --size 540x1200 --bit-rate 2000000 $SCREENS/$file")
        Thread.sleep(1200)
        rule.mainClock.autoAdvance = false
        try {
            fun frames(n: Int) = repeat(n) {
                rule.mainClock.advanceTimeByFrame()
                Thread.sleep(16)
            }
            var down = SystemClock.uptimeMillis()
            fun touch(action: Int, at: Float) {
                val now = SystemClock.uptimeMillis()
                if (action == MotionEvent.ACTION_DOWN) down = now
                val event = MotionEvent.obtain(down, now, action, at, y, 0)
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                automation.injectInputEvent(event, true)
                event.recycle()
            }
            fun drag(from: Float, to: Float, steps: Int) {
                for (step in 1..steps) {
                    touch(MotionEvent.ACTION_MOVE, x(from + (to - from) * step / steps))
                    frames(2)
                }
            }
            frames(20)
            // 按住第一项：透镜鼓起来
            touch(MotionEvent.ACTION_DOWN, x(0f))
            frames(45)
            // 慢慢拖到第三项，停一下，再拖回第二项
            drag(0f, 2f, 40)
            frames(30)
            drag(2f, 1f, 20)
            frames(30)
            // 松手：落到第二项再缩回去
            touch(MotionEvent.ACTION_UP, x(1f))
            frames(60)
            // 点第一项：透镜滑过去，路上鼓一下
            touch(MotionEvent.ACTION_DOWN, x(0f))
            frames(4)
            touch(MotionEvent.ACTION_UP, x(0f))
            frames(70)
        } finally {
            rule.mainClock.autoAdvance = true
        }
        // 停下录屏（录屏程序收到 SIGINT 会把文件写完整），等它退出
        shell("pkill -INT screenrecord")
        java.io.FileInputStream(recording.fileDescriptor).use { it.readBytes() }
        recording.close()
        rule.waitForIdle()
    }

    /** 以 shell 的身份跑一条命令，返回它的输出。 */
    private fun shellOutput(command: String): String =
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { fd ->
            java.io.FileInputStream(fd.fileDescriptor).use { String(it.readBytes()) }
        }

    /** 点底栏的"设置"。 */
    private fun openSettings() = explain("openSettings") {
        rule.onNode(hasContentDescription(s(R.string.tabs_settings)) and hasClickAction()).performClick()
        waitFor(s(R.string.settings_section_general))
    }

    /**
     * 设置（#181）：主站的设置能读能改、改了当场存到主站；被设置规则锁住的存不上，拨回去并说明；
     * 外观只存在这台设备上；关于页有 SeekCloud 的署名和许可证。
     */
    @Test
    fun settingsReadSaveAndLock() {
        launch()
        connect(siteB)
        signIn()
        try {
            openSettings()
            tap(s(R.string.settings_section_general))
            waitFor(s(R.string.general_effort))
            // 外观固定成深色：存在这台设备上，不经主站
            tap(s(R.string.general_theme_dark))
            rule.waitUntil(5_000) { prefs().getString(AppPreferences.THEME, null) == "Dark" }
            // 默认思考强度：点了就存到主站
            waitFor(s(R.string.effort_low))
            tap(s(R.string.effort_low))
            rule.waitUntil(10_000) { setting(siteB, "default-effort").contains("\"low\"") }
            // 设置规则锁住以后：存不上，拨回"低"，说明"此项设置不可修改"
            lock(siteB, "default_effort")
            tap(s(R.string.effort_max))
            waitFor(s(R.string.error_setting_locked))
            rule.onNode(hasText(s(R.string.effort_low)) and isSelected()).assertExists()
            assertTrue(setting(siteB, "default-effort").contains("\"low\""))
            // 锁住的那一项不能再点
            rule.onNode(hasText(s(R.string.effort_max)) and hasClickAction()).assertIsNotEnabled()
            back()

            // 会话：宿主机断开后等待的时长
            tap(s(R.string.settings_section_sessions))
            waitFor(s(R.string.session_settings_grace))
            val tenMinutes = MeasureFormat.getInstance(ULocale.forLocale(context.resources.configuration.locales[0]), MeasureFormat.FormatWidth.WIDE)
                .format(Measure(10, MeasureUnit.MINUTE))
            tap(tenMinutes)
            rule.waitUntil(10_000) { setting(siteB, "host-offline-grace").contains("600") }
            back()

            // 关于：署名（附加条款要求的原文）、许可证
            tap(s(R.string.settings_about))
            waitFor("基于 SeekCloud")
            waitFor(s(R.string.legal_agpl))
            // 顶栏的返回箭头也回到分类列表
            rule.onNode(hasContentDescription(s(R.string.back)) and hasClickAction()).performClick()
            waitFor(s(R.string.settings_section_general))
        } finally {
            lock(siteB)
            putSetting(siteB, "default-effort", """{"effort":"high"}""")
            putSetting(siteB, "host-offline-grace", """{"seconds":120}""")
        }
    }

    /** 主站上一项设置现在的值（JSON）。 */
    private fun setting(site: String, name: String): String {
        val request = Request.Builder().url("$site/api/settings/$name").header("Authorization", "Bearer ${appToken(site)}").build()
        return OkHttpClient().newCall(request).execute().use { it.body.string() }
    }

    private fun putSetting(site: String, name: String, json: String) {
        val request = Request.Builder().url("$site/api/settings/$name")
            .header("Authorization", "Bearer ${appToken(site)}")
            .put(json.toRequestBody(JSON))
            .build()
        OkHttpClient().newCall(request).execute().close()
    }

    /** 让假主站的设置规则不许改这几项（只有测试用的假主站有这个接口，见 app-test-server.ts）；不给就解除。 */
    private fun lock(site: String, vararg keys: String) {
        val body = keys.joinToString(",", "{\"keys\":[", "]}") { "\"$it\"" }
        OkHttpClient().newCall(Request.Builder().url("$site/__test/lock").post(body.toRequestBody(JSON)).build()).execute().use {
            check(it.isSuccessful) { "lock: HTTP ${it.code}" }
        }
    }

    /** 以 shell 的身份跑一条命令，等它跑完。 */
    private fun shell(command: String) {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { fd ->
            java.io.FileInputStream(fd.fileDescriptor).use { it.readBytes() }
        }
    }

    @Test
    fun workingTurnControls() {
        launch()
        connect(siteB)
        signIn()
        // 假宿主机不回复：新会话一直在准备沙箱，Agent 算在工作
        nextTurn(siteB, """{"hold":true}""")
        try {
            val title = "Working ${System.nanoTime()}"
            startSession(siteB, title)
            waitFor(title)
            tap(title)
            waitFor(s(R.string.status_preparing_sandbox))
            // 输入框空着是停止键
            rule.onNode(hasContentDescription(s(R.string.composer_stop)) and hasClickAction()).assertExists()

            // 有字时是 ↵：插进当前回合，当场算交给 Agent（✓✓）
            type("Do not touch the database")
            rule.onNode(hasContentDescription(s(R.string.composer_send_now)) and hasClickAction()).performClick()
            waitForDescription(s(R.string.chat_delivered))

            // ⌄ 里的"稍后排队"：排在对话末尾，最前面的一条有"立即发送"
            type("Make it blue")
            rule.onNode(hasContentDescription(s(R.string.composer_more_send)) and hasClickAction()).performClick()
            tapSheet(s(R.string.composer_later))
            waitFor(s(R.string.chat_send_now))

            // 撤回并编辑：排队的消息没了，字回到输入框
            rule.onNode(hasContentDescription(s(R.string.chat_withdraw)) and hasClickAction()).performClick()
            rule.waitUntil(20_000) { rule.onAllNodes(hasText(s(R.string.chat_send_now))).fetchSemanticsNodes().isEmpty() }
            // 排队的消息由事件流拿掉，字由撤回的回应放回输入框：两样先后不定，等字回来
            explain("text back in the composer") {
                rule.waitUntil(20_000) { rule.onAllNodes(hasSetTextAction() and hasText("Make it blue")).fetchSemanticsNodes().isNotEmpty() }
            }

            // ⌄ 里的"停止"：回合停下，输入框里的字不动
            rule.onNode(hasContentDescription(s(R.string.composer_more_send)) and hasClickAction()).performClick()
            tapSheet(s(R.string.composer_stop))
            waitFor(s(R.string.chat_turn_stopped))
            rule.onNode(hasSetTextAction()).assert(hasText("Make it blue"))
        } finally {
            nextTurn(siteB, """{"hold":false}""")
        }
    }

    private fun waitForDescription(description: String) = explain("waitForDescription \"$description\"") {
        rule.waitUntil(20_000) { rule.onAllNodes(hasContentDescription(description)).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun statusMarksAndTheAwaitingHint() {
        launch()
        connect(siteA)
        signIn()
        // 回合结束时 Agent 在问问题：会话"等你输入"
        nextTurn(siteA, """{"events":[{"type":"message","text":"要我把测试也一起改了吗？"}]}""")
        val title = "Awaiting ${System.nanoTime()}"
        startSession(siteA, title)
        waitForRow(title, s(R.string.status_awaiting_input))
        // 新会话页的输入框上面提示它在等你输入
        openNewSession()
        waitFor(s(R.string.awaiting_one, title))
    }

    @Test
    fun failedSessionShowsTheWarningMark() {
        launch()
        connect(siteB)
        signIn()
        nextTurn(siteB, """{"failSandbox":true}""")
        val title = "Failing ${System.nanoTime()}"
        startSession(siteB, title)
        waitForRow(title, s(R.string.status_failed))
    }

    @Test
    fun wideScreenShowsTheListAndTheNewSessionPage() {
        launch()
        connect(siteA)
        signIn()
        scenario?.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        // 横过来以后够宽：左边列表（底栏在列表那一栏的底部），右边新会话页
        waitFor(s(R.string.new_session_placeholder))
        waitForList()
        scenario?.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        waitForList()
        rule.waitUntil(20_000) {
            rule.onAllNodes(hasContentDescription(s(R.string.sidebar_new_session)) and hasClickAction()).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** 列表里这个会话的那一行带着这个状态标记（行是一个整体，标记的说明并在里面）。 */
    private fun waitForRow(title: String, mark: String) = explain("row \"$title\" with \"$mark\"") {
        rule.waitUntil(30_000) {
            rule.onAllNodes(hasText(title) and hasContentDescription(mark)).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun openNewSession() = explain("tap new session") {
        rule.onNode(hasContentDescription(s(R.string.sidebar_new_session)) and hasClickAction()).performClick()
    }

    @Test
    fun sessionMenuActions() {
        launch()
        connect(siteA)
        signIn()
        val title = "Menu session ${System.nanoTime()}"
        startSession(siteA, title)
        waitFor(title)

        // 长按打开菜单，重命名
        val renamed = "$title renamed"
        rule.onNode(hasText(title) and hasClickAction()).performTouchInput { longClick() }
        waitFor(s(R.string.session_copy_link))
        tapSheet(s(R.string.common_rename))
        waitFor(s(R.string.session_title_label))
        type(renamed)
        tapSheet(s(R.string.common_save))
        waitFor(renamed)

        // 回合在没人开着它时结束：有新内容；标为已读以后蓝点消失
        waitForRow(renamed, s(R.string.status_unread))
        openMenuOf(renamed)
        tapSheet(s(R.string.session_mark_read))
        rule.waitUntil(20_000) {
            rule.onAllNodes(hasText(renamed) and hasContentDescription(s(R.string.status_unread))).fetchSemanticsNodes().isEmpty()
        }

        // 用"⋯"打开菜单，置顶：出现"已置顶"这一类
        openMenuOf(renamed)
        tapSheet(s(R.string.session_pin))
        waitFor(s(R.string.sidebar_pinned))

        // 归档：进"已归档"（收着），置顶取消
        openMenuOf(renamed)
        tapSheet(s(R.string.session_archive))
        waitFor(s(R.string.sidebar_archived))
        rule.waitUntil(20_000) { rule.onAllNodes(hasText(renamed)).fetchSemanticsNodes().isEmpty() }

        // 展开"已归档"，删除（要确认）：从列表里消失
        tap(s(R.string.sidebar_archived))
        waitFor(renamed)
        openMenuOf(renamed)
        tapSheet(s(R.string.common_delete))
        waitFor(s(R.string.session_delete_hint))
        tapSheet(s(R.string.session_delete_forever))
        rule.waitUntil(20_000) { rule.onAllNodes(hasText(renamed)).fetchSemanticsNodes().isEmpty() }
    }

    private fun openMenuOf(title: String) {
        rule.onNode(hasContentDescription(s(R.string.session_list_options, title))).performScrollTo().performClick()
        waitFor(s(R.string.session_copy_link))
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

    /** 以另一台设备登录，拿到设备令牌。 */
    private fun appToken(site: String): String {
        val login = """{"password":"$password","client":"app","deviceName":"UI test"}""".toRequestBody(JSON)
        return OkHttpClient().newCall(Request.Builder().url("$site/api/auth/login").post(login).build()).execute().use {
            Json.parseToJsonElement(it.body.string()).jsonObject.getValue("token").jsonPrimitive.content
        }
    }

    /** 假主站的下一个回合怎么回（只有测试用的假主站有这个接口，见 app-test-server.ts）。 */
    private fun nextTurn(site: String, json: String) {
        val request = Request.Builder().url("$site/__test/next-turn").post(json.toRequestBody(JSON)).build()
        OkHttpClient().newCall(request).execute().use { check(it.isSuccessful) { "next turn: HTTP ${it.code}" } }
    }

    /** 不使用仓库发起一个会话（#191），标题就是这段话。返回会话的短 ID。 */
    private fun startSession(site: String, text: String): String {
        val token = appToken(site)
        val body = """{"text":"$text"}""".toRequestBody(JSON)
        val request = Request.Builder().url("$site/api/sessions").header("Authorization", "Bearer $token").post(body).build()
        return OkHttpClient().newCall(request).execute().use {
            check(it.isSuccessful) { "start session: HTTP ${it.code}" }
            Json.parseToJsonElement(it.body.string()).jsonObject.getValue("shortId").jsonPrimitive.content
        }
    }

    /** 替假宿主机给会话报一份对比基础分支的改动（只有测试用的假主站有这个接口，见 app-test-server.ts）。 */
    private fun diff(site: String, shortId: String, repos: String) {
        val request = Request.Builder().url("$site/__test/diff").post("""{"shortId":"$shortId","repos":$repos}""".toRequestBody(JSON)).build()
        OkHttpClient().newCall(request).execute().use { check(it.isSuccessful) { "diff: HTTP ${it.code}" } }
    }

    /** 以另一台设备登录，把别的 App 设备都退出（就是网页上设置 → 账户 → 登录设备里点"退出"）。 */
    private fun revokeOtherAppDevices(site: String) {
        val http = OkHttpClient()
        val token = appToken(site)
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

    private val res get() = context.resources

    private companion object {
        val JSON = "application/json".toMediaType()

        /** 假主站的 Agent 默认的回复。 */
        const val REPLY = "收到。"

        /** 截图放在这里（shell 能写、App 卸载以后还在），CI 拉下来。 */
        const val SCREENS = "/data/local/tmp/seekcloud-screens"
    }
}

private operator fun SemanticsMatcher.not() = SemanticsMatcher("NOT (${this.description})") { !this.matches(it) }
