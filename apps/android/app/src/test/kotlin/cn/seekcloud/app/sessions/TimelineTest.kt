package cn.seekcloud.app.sessions

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 会话事件整理成时间线（#182），和网页的 timeline.test.ts 同一套情形。 */
class TimelineTest {
    private val at = "2026-10-31T00:00:00Z"

    /** 事件按顺序编号，都在第 1 个回合里。 */
    private fun events(vararg bodies: (Int) -> SessionEvent) = bodies.mapIndexed { i, body -> body(i + 1) }

    private fun user(text: String, queued: List<String>? = null, injected: Boolean = false, followUp: String? = null) =
        { seq: Int -> SessionEvent.UserMessage(seq, at, 1, text, queued, injected, followUp) }
    private val started = { seq: Int -> SessionEvent.TurnStarted(seq, at, 1) }
    private fun ended(reason: String = "completed", error: SafeError? = null) = { seq: Int -> SessionEvent.TurnEnded(seq, at, 1, reason, error) }
    private fun message(text: String) = { seq: Int -> SessionEvent.Message(seq, at, 1, text) }
    private fun queued(id: String, text: String) = { seq: Int -> SessionEvent.MessageQueued(seq, at, 1, id, text) }
    private fun withdrawn(id: String) = { seq: Int -> SessionEvent.MessageWithdrawn(seq, at, 1, id) }
    private fun call(id: String, name: String, input: kotlinx.serialization.json.JsonElement = JsonNull) =
        { seq: Int -> SessionEvent.ToolCall(seq, at, 1, id, name, input) }
    private fun result(id: String, output: String) = { seq: Int -> SessionEvent.ToolResult(seq, at, 1, id, output, false) }
    private fun status(status: String, detail: String? = null, error: SafeError? = null) =
        { seq: Int -> SessionEvent.Status(seq, at, 1, status, detail, error) }
    private fun todo(vararg items: Pair<String, String>) = { seq: Int -> SessionEvent.Todo(seq, at, 1, items.map { TodoItem(it.first, it.second) }) }
    private fun workspace(files: List<FileChange>) = { seq: Int ->
        SessionEvent.Workspace(seq, at, 1, listOf(RepoOutcome("octo/app", "pushed", files), RepoOutcome("octo/lib", "pushed", emptyList())))
    }

    private val files = listOf(FileChange("src/a.ts", additions = 3, deletions = 1), FileChange("logo.png", binary = true))

    @Test
    fun queuedMessagesAreWithdrawnOrBecomeUserMessages() {
        val timeline = buildTimeline(
            events(
                queued("q1", "改成蓝色"),
                queued("q2", "算了"),
                queued("q3", "先别动数据库"),
                withdrawn("q2"),
                user("先别动数据库", queued = listOf("q3"), injected = true),
            ),
        )
        assertEquals(listOf(QueuedMessage("q1", "改成蓝色")), timeline.queued)
        assertEquals(listOf("先别动数据库"), timeline.items.map { (it as TimelineItem.User).text })
    }

    @Test
    fun userMessagesAreDeliveredWhenTheTurnStartsOrWhenInjected() {
        fun delivered(vararg bodies: (Int) -> SessionEvent) =
            buildTimeline(events(*bodies)).items.filterIsInstance<TimelineItem.User>().map { it.delivered }
        assertEquals(listOf(false), delivered(user("改标题"), status("running", "preparing_sandbox")))
        assertEquals(listOf(true), delivered(user("改标题"), started))
        assertEquals(listOf(true, false), delivered(user("改标题"), started, ended(), user("再改一下")))
        assertEquals(listOf(true, true), delivered(user("改标题"), started, user("先别动数据库", injected = true)))
    }

    @Test
    fun lastReplyOfAnEndedTurnCarriesTheWholeReply() {
        val timeline = buildTimeline(
            events(
                user("改标题"), started, message("我先看看代码。"), call("c1", "Read"), message("改好了。"), ended(),
                user("再改一下"), started, message("第二个回合。"),
            ),
        )
        val replies = timeline.items.filterIsInstance<TimelineItem.Assistant>()
        assertEquals(listOf(null, "我先看看代码。\n\n改好了。", null), replies.map { it.turnEnd?.reply })
        assertEquals(at, replies[1].turnEnd?.at)
    }

    @Test
    fun consecutiveToolCallsFormOneGroupAndResultsAttach() {
        val timeline = buildTimeline(events(call("a", "Read"), call("b", "Bash"), result("a", "内容")))
        val group = timeline.items.single() as TimelineItem.Tools
        assertEquals(ToolOutcome("内容", false), group.calls[0].result)
        assertNull(group.calls[1].result)
        // 还在跑的是 b
        assertEquals("Bash", timeline.activity?.name)
    }

    @Test
    fun planKeepsTheLatestAndGoesStaleThenAway() {
        fun plan(vararg bodies: (Int) -> SessionEvent) = buildTimeline(events(*bodies)).plan
        assertEquals(Plan(listOf(TodoItem("一", "completed")), false), plan(started, todo("一" to "in_progress"), todo("一" to "completed")))
        assertEquals(true, plan(started, todo("一" to "in_progress"), user("换个做法", injected = true))?.stale)
        assertNull(plan(started, todo("一" to "in_progress"), ended()))
        assertTrue(buildTimeline(events(todo("一" to "in_progress"))).items.isEmpty())
    }

    @Test
    fun failuresBecomeNoticesWithTheirErrors() {
        val error = SafeError("model_unavailable", 502, "k3x9")
        val items = buildTimeline(
            events(ended(), ended("failed", error), ended("stopped"), status("failed", error = SafeError("sandbox_unavailable"))),
        ).items
        assertEquals(
            listOf<TimelineNotice>(
                TimelineNotice.TurnFailed(error),
                TimelineNotice.TurnStopped(null),
                TimelineNotice.SessionFailed(SafeError("sandbox_unavailable")),
            ),
            items.map { (it as TimelineItem.Notice).notice },
        )
    }

    @Test
    fun activityIsTheRunningToolAndClearsWhenDoneOrTurnEnds() {
        fun activity(vararg bodies: (Int) -> SessionEvent) = buildTimeline(events(*bodies)).activity
        val start = arrayOf(user("修一下测试"), started, message("我先看看仓库的结构。"))
        assertNull(activity(*start))
        assertEquals("c1", activity(*start, call("c1", "Bash"))?.let { "c1" })
        assertNull(activity(*start, call("c1", "Bash"), result("c1", "ok")))
        assertNull(activity(*start, call("c1", "Bash"), ended("stopped")))
        assertNull(activity(*start, call("c1", "Bash"), started))
    }

    @Test
    fun changesAttachToTheLastReplyOfTheirTurn() {
        val timeline = buildTimeline(events(user("改一下"), started, message("先看看"), message("改好了"), workspace(files), ended()))
        val replies = timeline.items.filterIsInstance<TimelineItem.Assistant>()
        assertNull(replies[0].turnEnd)
        // 没改文件的仓库不列
        assertEquals(TurnChanges(listOf(RepoOutcome("octo/app", "pushed", files))), replies[1].turnEnd?.changes)

        val nothing = buildTimeline(events(started, message("没什么要改的"), workspace(emptyList()), ended()))
        assertNull((nothing.items.single() as TimelineItem.Assistant).turnEnd?.changes)
    }

    @Test
    fun eachTurnHasItsOwnChangesCard() {
        val timeline = buildTimeline(
            events(
                user("一"), started, message("改了一"), workspace(files), ended(),
                { seq -> SessionEvent.UserMessage(seq, at, 2, "二") },
                { seq -> SessionEvent.TurnStarted(seq, at, 2) },
                { seq -> SessionEvent.Message(seq, at, 2, "改了二") },
                { seq -> SessionEvent.Workspace(seq, at, 2, listOf(RepoOutcome("octo/app", "pushed", files.take(1)))) },
                { seq -> SessionEvent.TurnEnded(seq, at, 2, "completed") },
            ),
        )
        val cards = timeline.items.filterIsInstance<TimelineItem.Assistant>().map { it.turnEnd?.changes?.repos?.single()?.files?.size }
        assertEquals(listOf(2, 1), cards)
    }

    @Test
    fun changesWithoutReplyStandAloneAndLateOnesAttachBack() {
        val silent = buildTimeline(events(started, workspace(files), ended()))
        assertTrue(silent.items.single() is TimelineItem.Changes)

        val stopped = buildTimeline(events(started, message("改到一半"), ended("stopped"), workspace(files)))
        val reply = stopped.items[0] as TimelineItem.Assistant
        assertEquals(files, reply.turnEnd?.changes?.repos?.single()?.files)
        assertEquals(TimelineNotice.TurnStopped(null), (stopped.items[1] as TimelineItem.Notice).notice)
    }

    @Test
    fun followUpIsANoticeAndGivingUpTellsTheRepos() {
        val timeline = buildTimeline(
            events(
                user("推送失败……", followUp = "push_failed"), started, ended(),
                { seq -> SessionEvent.PushGaveUp(seq, at, 1, listOf("octo/app")) },
            ),
        )
        assertEquals(
            listOf<TimelineNotice>(TimelineNotice.PushFollowUp, TimelineNotice.PushGaveUp(listOf("octo/app"))),
            timeline.items.map { (it as TimelineItem.Notice).notice },
        )
    }

    @Test
    fun statusAndSinceFollowTheLatestStatusEvent() {
        val timeline = buildTimeline(
            listOf(
                SessionEvent.Status(1, "2026-10-31T00:00:00Z", null, "running", "preparing_sandbox"),
                SessionEvent.Status(2, "2026-10-31T00:00:05Z", null, "running", null),
            ),
        )
        assertEquals("running", timeline.status)
        assertNull(timeline.detail)
        // 状态没变（只是附加说明变了），用时接着算
        assertEquals("2026-10-31T00:00:00Z", timeline.since)
    }

    @Test
    fun toolSummaryPrefersPathCommandAndQuery() {
        assertEquals("a.ts", toolSummary(buildJsonObject { put("file_path", "a.ts"); put("limit", 10) }))
        assertEquals("pnpm test", toolSummary(buildJsonObject { put("command", "pnpm test") }))
        assertEquals("x", toolSummary(buildJsonObject { put("other", 1); put("name", "x") }))
        assertEquals("", toolSummary(JsonNull))
        assertEquals("ls", toolSummary(JsonPrimitive("ls")))
    }

    @Test
    fun draftIsAdoptedByTheMatchingMessage() {
        var key = -10
        val next = { key-- }
        val draft = Draft(-1, "我先看")
        // 完整的消息接过临时回复
        assertEquals(Settled(null, -1), settleDraft(draft, SessionEvent.Message(5, at, 1, "我先看看代码。"), next))
        // 下一步的增量先到了：前面这段交给消息，多出来的留着
        assertEquals(Settled(Draft(-10, "下一步"), -1), settleDraft(Draft(-1, "我先看下一步"), SessionEvent.Message(5, at, 1, "我先看"), next))
        // 对不上：作废
        assertEquals(Settled(null), settleDraft(draft, SessionEvent.Message(5, at, 1, "别的"), next))
        // 工具调用、回合开始和结束：作废
        assertEquals(Settled(null), settleDraft(draft, SessionEvent.ToolCall(5, at, 1, "c", "Bash", JsonNull), next))
        // 别的事件不动它
        assertEquals(Settled(draft), settleDraft(draft, SessionEvent.Todo(5, at, 1, emptyList()), next))
    }
}
