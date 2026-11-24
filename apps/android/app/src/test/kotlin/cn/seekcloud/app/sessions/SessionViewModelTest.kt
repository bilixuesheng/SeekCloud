package cn.seekcloud.app.sessions

import cn.seekcloud.app.net.ApiError
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.EventStreamClosed
import cn.seekcloud.app.net.SseEvent
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** 会话页的数据（#182）：历史和新事件、逐字输出接续、发消息、排队的消息、断线重连。 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    /** 假的事件流：每次连上记下带的序号，事件从同一个通道里读（断开重连接着读）。 */
    private class FakeStream {
        val calls = mutableListOf<String?>()
        val channel = Channel<SseEvent>(Channel.UNLIMITED)
        var closeWith: Throwable? = null

        fun open(last: String?, onConnected: (Boolean) -> Unit): Flow<SseEvent> = flow {
            calls += last
            closeWith?.let { throw it }
            onConnected(true)
            for (event in channel) emit(event)
        }

        fun send(seq: Int, body: String) {
            channel.trySend(SseEvent("session", seq.toString(), """{"seq":$seq,"at":"2026-10-31T00:00:0${seq % 10}Z","turn":1,$body}"""))
        }

        fun delta(text: String) {
            channel.trySend(SseEvent("delta", null, """{"kind":"text","text":"$text"}"""))
        }
    }

    private class FakeApi : SessionPageApi {
        var summary = SessionSummary("s1", "修一下测试", "waiting", createdAt = "t", updatedAt = "t")
        val sent = mutableListOf<Pair<String, String>>()
        val models = mutableListOf<Pair<String?, String?>>()
        var failSend: Exception? = null
        var withdrawn: String? = "改成蓝色"

        override fun session(shortId: String) = summary
        override fun send(shortId: String, text: String, mode: String, model: String?, effort: String?) {
            failSend?.let { throw it }
            sent += text to mode
            models += model to effort
        }
        override fun models() = ModelList(
            models = listOf(
                ModelOption("deepseek/deepseek-flash", efforts = listOf("off", "high", "max")),
                ModelOption("acme/plain"),
            ),
            defaultEffort = "high",
        )
        override fun stop(shortId: String) = Unit
        override fun withdraw(shortId: String, queueId: String) = withdrawn
        override fun sendNow(shortId: String, queueId: String) = Unit

        var serverPins = listOf<MessagePin>()
        var failPin: Exception? = null
        override fun pins(shortId: String) = serverPins
        override fun setPinned(shortId: String, seq: Int, pinned: Boolean): List<MessagePin> {
            failPin?.let { throw it }
            serverPins = if (pinned) serverPins + MessagePin(seq, "健康检查", "t") else serverPins.filterNot { it.seq == seq }
            return serverPins
        }
        override fun diff(shortId: String) = listOf(RepoDiff("octo/app", "main", listOf(DiffFile("a.ts", additions = 1))))
    }

    private class FakeActions : SessionActions {
        val unread = mutableListOf<Boolean>()
        override fun rename(shortId: String, title: String) = Unit
        override fun setPinned(shortId: String, pinned: Boolean) = Unit
        override fun setUnread(shortId: String, unread: Boolean) {
            this.unread += unread
        }
        override fun archive(shortId: String) = Unit
        override fun unarchive(shortId: String) = Unit
        override fun delete(shortId: String) = Unit
        override fun moveToGroup(shortId: String, groupId: String?) = Unit
        override fun createGroup(name: String) = "g"
    }

    private val stream = FakeStream()
    private val api = FakeApi()
    private val actions = FakeActions()
    private var signedOut = false

    private fun TestScope.model() = SessionViewModel(
        shortId = "s1",
        api = api,
        actions = actions,
        stream = stream::open,
        onSignedOut = { signedOut = true },
        now = { Instant.parse("2026-10-31T00:01:00Z") },
        io = dispatcher,
        work = dispatcher,
    ).also { it.start() }

    @Test
    fun historyShowsWholeAndLaterEventsAreLive() = runTest(dispatcher) {
        stream.send(1, """"type":"user.message","text":"修一下测试"""")
        stream.send(2, """"type":"turn.started"""")
        stream.send(3, """"type":"message","text":"我先看看。"""")
        val vm = model()
        runCurrent()
        // 历史还没补完：一条都不算新的
        assertEquals(Int.MAX_VALUE, vm.page.value.liveAfter)
        advanceTimeBy(300)
        assertEquals(3, vm.page.value.liveAfter)
        assertTrue(vm.page.value.loaded)
        // 用户消息和回复（回合开始不占一行）
        assertEquals(2, vm.page.value.timeline.items.size)
        stream.send(4, """"type":"message","text":"改好了。"""")
        advanceUntilIdle()
        assertEquals(3, vm.page.value.timeline.items.size)
        assertEquals(3, vm.page.value.liveAfter)
        vm.stop()
    }

    @Test
    fun deltasBecomeADraftThatTheFullMessageTakesOver() = runTest(dispatcher) {
        val vm = model()
        advanceTimeBy(2000)
        stream.delta("我先")
        stream.delta("看看")
        runCurrent()
        val draft = vm.page.value.draft
        assertEquals("我先看看", draft?.text)
        stream.send(1, """"type":"message","text":"我先看看代码。"""")
        advanceUntilIdle()
        assertNull(vm.page.value.draft)
        assertEquals(draft?.key, vm.page.value.adopted[1])
        vm.stop()
    }

    @Test
    fun openingMarksTheSessionRead() = runTest(dispatcher) {
        api.summary = api.summary.copy(unread = true)
        val vm = model()
        advanceUntilIdle()
        assertEquals(listOf(false), actions.unread)
        assertEquals("修一下测试", vm.session.value?.title)
        vm.stop()
    }

    @Test
    fun sentMessageShowsAtOnceUntilTheServerEchoesIt() = runTest(dispatcher) {
        val vm = model()
        advanceTimeBy(2000)
        vm.setText("改成蓝色")
        vm.send()
        // 先显示出来，输入框清空
        assertEquals("改成蓝色", vm.composer.value.pending?.text)
        assertEquals("", vm.composer.value.text)
        advanceUntilIdle()
        assertEquals(listOf("改成蓝色" to "now"), api.sent)
        assertEquals("改成蓝色", vm.composer.value.pending?.text)
        stream.send(1, """"type":"user.message","text":"改成蓝色"""")
        advanceUntilIdle()
        assertNull(vm.composer.value.pending)
        vm.stop()
    }

    @Test
    fun chosenModelGoesWithTheNextMessageOnly() = runTest(dispatcher) {
        val vm = model()
        advanceTimeBy(2000)
        // 模型不支持的档位换成最近的一档；没声明推理等级的模型只有"关闭"
        vm.choose("deepseek/deepseek-flash", "medium")
        assertEquals("deepseek/deepseek-flash" to "high", vm.choice.value)
        vm.choose("acme/plain", "high")
        assertEquals("acme/plain" to "off", vm.choice.value)
        vm.send("换个模型试试")
        advanceUntilIdle()
        assertEquals(listOf<Pair<String?, String?>>("acme/plain" to "off"), api.models)
        // 发出去以后跟着会话走
        assertNull(vm.choice.value)
        vm.send("接着来")
        advanceUntilIdle()
        assertEquals(null to null, api.models.last())
        vm.stop()
    }

    @Test
    fun pinningShowsAPlaceholderThenTheTitleAndRollsBackOnFailure() = runTest(dispatcher) {
        val vm = model()
        advanceTimeBy(2000)
        vm.togglePin(7, pinned = true)
        // 先在本地加上，短标题还在生成
        assertEquals(listOf(MessagePin(7, null, "2026-10-31T00:01:00Z")), vm.pins.value)
        advanceUntilIdle()
        assertEquals("健康检查", vm.pins.value.single().title)

        api.failPin = ApiException(404, ApiError("message_not_found", "消息不存在"))
        vm.togglePin(7, pinned = false)
        assertTrue(vm.pins.value.isEmpty())
        advanceUntilIdle()
        // 没成功：换回主站上的样子，说明原因
        assertEquals(listOf(7), vm.pins.value.map { it.seq })
        assertTrue(vm.composer.value.failure is ApiException)
        vm.stop()
    }

    @Test
    fun changesPanelLoadsTheLatestDiff() = runTest(dispatcher) {
        val vm = model()
        advanceTimeBy(2000)
        vm.openChanges("a.ts")
        assertEquals(ChangesPanelUi("a.ts"), vm.changes.value)
        advanceUntilIdle()
        assertEquals("a.ts", vm.changes.value?.repos?.single()?.files?.single()?.path)
        vm.closeChanges()
        assertNull(vm.changes.value)
        vm.stop()
    }

    @Test
    fun failedSendGivesTheTextBack() = runTest(dispatcher) {
        api.failSend = ApiException(409, ApiError("session_archived", "会话已归档"))
        val vm = model()
        advanceTimeBy(2000)
        vm.setText("改成蓝色")
        vm.send(mode = "later")
        vm.setText("还有")
        advanceUntilIdle()
        assertNull(vm.composer.value.pending)
        assertEquals("改成蓝色\n还有", vm.composer.value.text)
        assertTrue(vm.composer.value.failure is ApiException)
        assertFalse(vm.composer.value.busy)
        vm.stop()
    }

    @Test
    fun withdrawingPutsTheTextBackInTheComposer() = runTest(dispatcher) {
        val vm = model()
        advanceTimeBy(2000)
        vm.setText("先别动数据库")
        vm.withdraw("q1", restore = true)
        assertEquals(QueueAction.Restore, vm.composer.value.queue["q1"])
        advanceUntilIdle()
        assertEquals("改成蓝色\n先别动数据库", vm.composer.value.text)
        assertTrue(vm.composer.value.queue.isEmpty())
        vm.stop()
    }

    @Test
    fun reconnectingContinuesFromTheLastSequence() = runTest(dispatcher) {
        stream.send(1, """"type":"user.message","text":"一"""")
        stream.send(2, """"type":"turn.started"""")
        val vm = model()
        advanceTimeBy(2000)
        // 切到后台再回来
        vm.stop()
        vm.start()
        stream.send(2, """"type":"turn.started"""")
        stream.send(3, """"type":"message","text":"二"""")
        advanceUntilIdle()
        assertEquals(listOf(null, "2"), stream.calls)
        // 重复的不再加一遍
        assertEquals(2, vm.page.value.timeline.items.size)
        vm.stop()
    }

    @Test
    fun missingSessionAndSignedOutDevice() = runTest(dispatcher) {
        stream.closeWith = EventStreamClosed(404, null)
        val vm = model()
        advanceUntilIdle()
        assertTrue(vm.missing.value)

        stream.closeWith = EventStreamClosed(401, null)
        vm.start()
        advanceUntilIdle()
        assertTrue(signedOut)
    }
}
