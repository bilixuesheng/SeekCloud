package cn.seekcloud.app.sessions

import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerTrust
import cn.seekcloud.app.net.serverClient
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 新会话页（#124）：思考强度怎么取（照协议包的 fitEffort）、记住的模型下线了换回默认的、什么时候能发送、请求体。 */
class NewSessionTest {
    private val flash = ModelOption("deepseek/deepseek-flash", "deepseek", "", "Flash", efforts = listOf("off", "high", "max"))
    private val plain = ModelOption("custom/plain", "custom", "Mine", "Plain")
    private val models = ModelList(listOf(flash, plain), defaultModel = flash.id, defaultEffort = "medium")

    @Test
    fun fitEffortPicksTheNearestPreferringLower() {
        assertEquals("high", fitEffort(listOf("off", "high", "max"), "high"))
        // medium 离 high 和 off 一样近吗：off 差 3 档，high 差 1 档
        assertEquals("high", fitEffort(listOf("off", "high", "max"), "medium"))
        // 一样近时取低的那档
        assertEquals("low", fitEffort(listOf("low", "high"), "medium"))
        assertEquals("max", fitEffort(listOf("max"), "off"))
        assertNull(fitEffort(emptyList(), "high"))
    }

    @Test
    fun effortFollowsTheModelAndTheDefault() {
        val ui = NewSessionUi(models = models)
        assertEquals(flash.id, ui.model)
        // 没动过：设置里的默认（medium）换成这个模型支持的最近一档
        assertEquals("high", ui.effort)
        assertEquals("max", ui.copy(chosenEffort = "max").effort)
        // 模型没声明推理等级：只有"关闭"
        assertEquals("off", ui.copy(chosenModel = plain.id).effort)
    }

    @Test
    fun rememberedModelThatIsGoneFallsBackToTheDefault() {
        assertEquals(flash.id, NewSessionUi(models = models, chosenModel = "gone/model").model)
        assertEquals(plain.id, NewSessionUi(models = models, chosenModel = plain.id).model)
        assertNull(NewSessionUi(models = ModelList(emptyList(), defaultModel = null)).model)
    }

    @Test
    fun rememberedRepoIsOnlyUsedWhenGitHubIsConnected() {
        val repo = Repo("acme/web", defaultBranch = "main")
        assertNull(NewSessionUi(repo = repo, github = GitHubStatus(connected = false)).chosenRepo)
        assertEquals(repo, NewSessionUi(repo = repo, github = GitHubStatus(connected = true)).chosenRepo)
    }

    @Test
    fun canSubmitNeedsTextGitHubCheckedAndAModel() {
        val ready = NewSessionUi(text = "Fix it", githubChecked = true, models = models)
        assertTrue(ready.canSubmit)
        assertFalse(ready.copy(text = "  ").canSubmit)
        assertFalse(ready.copy(githubChecked = false).canSubmit)
        assertFalse(ready.copy(busy = true).canSubmit)
        assertFalse(ready.copy(models = ModelList(emptyList())).canSubmit)
    }

    @Test
    fun createSendsOnlyWhatWasChosen() {
        MockWebServer().use { server ->
            server.start()
            val session = """{"shortId":"abc","title":"Fix it","status":"queued","createdAt":"t","updatedAt":"t"}"""
            repeat(2) { server.enqueue(MockResponse.Builder().code(201).body(session).build()) }
            val api = NewSessionApi(
                serverClient(ServerAddress(false, server.hostName, server.port), ServerTrust(allowCleartext = true), "ua", token = { "tok" }),
            )
            assertEquals("abc", api.create(NewSessionRequest("Fix it", model = "deepseek/deepseek-flash", effort = "high")).shortId)
            assertEquals(
                """{"text":"Fix it","model":"deepseek/deepseek-flash","effort":"high"}""",
                server.takeRequest().body!!.utf8(),
            )
            api.create(NewSessionRequest("Go", repo = "acme/web", baseBranch = "main", environmentId = "env1"))
            val request = server.takeRequest()
            assertEquals("/api/sessions", request.url.encodedPath)
            assertEquals("Bearer tok", request.headers["Authorization"])
            assertEquals("""{"text":"Go","repo":"acme/web","baseBranch":"main","environmentId":"env1"}""", request.body!!.utf8())
        }
    }
}
