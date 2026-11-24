package cn.seekcloud.app.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 会话列表（#124）：分类照网页的侧栏、标记的先后、事件流怎么改列表。 */
class SessionListTest {
    private fun session(
        id: String,
        sortKey: Double = 0.0,
        status: String = "waiting",
        pinned: Boolean = false,
        group: String? = null,
        title: String = id,
        updatedAt: String = "2026-01-01T00:00:00Z",
        detail: String? = null,
        unread: Boolean = false,
    ) = SessionSummary(
        shortId = id,
        title = title,
        status = status,
        detail = detail,
        repos = listOf(SessionRepo("acme/$id")),
        pinnedAt = if (pinned) "2026-01-01T00:00:00Z" else null,
        groupId = group,
        sortKey = sortKey,
        unread = unread,
        createdAt = "2026-01-01T00:00:00Z",
        updatedAt = updatedAt,
    )

    @Test
    fun sectionsFollowTheWebSidebar() {
        val groups = listOf(SessionGroup("g2", "Later", 2.0), SessionGroup("g1", "First", 1.0))
        val all = listOf(
            session("a", 1.0),
            session("b", 3.0),
            session("p", 5.0, pinned = true),
            session("x", 9.0, group = "g1"),
            session("y", 2.0, group = "missing"),
            session("z", 8.0, status = "archived"),
            session("pg", 4.0, pinned = true, group = "g1"),
        )
        val s = sections(all, groups)
        assertEquals(listOf("p", "pg"), s.pinned.map { it.shortId })
        assertEquals(listOf("g1", "g2"), s.groups.map { it.first.id })
        assertEquals(listOf("x"), s.groups[0].second.map { it.shortId })
        // 分组没了的放在"最近"里
        assertEquals(listOf("b", "y", "a"), s.recent.map { it.shortId })
        assertEquals(listOf("z"), s.archived.map { it.shortId })
    }

    @Test
    fun searchMatchesTitleAndRepoWithoutSections() {
        val all = listOf(
            session("a", title = "Fix login", updatedAt = "2026-01-02T00:00:00Z"),
            session("b", title = "Docs", updatedAt = "2026-01-03T00:00:00Z"),
            session("c", title = "LOGIN page", updatedAt = "2026-01-04T00:00:00Z", status = "archived"),
        )
        val s = sections(all, emptyList(), "  login ")
        assertEquals(listOf("c", "a"), s.recent.map { it.shortId })
        assertTrue(s.pinned.isEmpty() && s.archived.isEmpty())
        assertEquals(listOf("b"), sections(all, emptyList(), "acme/b").recent.map { it.shortId })
    }

    @Test
    fun marksInTheWebOrder() {
        assertEquals(StatusMark.Failed, statusMark(session("a", status = "failed", unread = true)))
        assertEquals(StatusMark.Running, statusMark(session("a", status = "running", detail = "awaiting_input")))
        assertEquals(StatusMark.Running, statusMark(session("a", status = "queued")))
        assertEquals(StatusMark.Awaiting, statusMark(session("a", status = "dormant", detail = "awaiting_input", unread = true)))
        assertNull(statusMark(session("a", status = "archived", detail = "awaiting_input")))
        assertEquals(StatusMark.Unread, statusMark(session("a", unread = true)))
        assertNull(statusMark(session("a")))
    }

    @Test
    fun streamEventsUpdateTheList() {
        var state = SessionListState()
        state = state.apply(
            "snapshot",
            """{"sessions":[{"shortId":"a","title":"A","status":"running","detail":null,"repos":[{"fullName":"acme/a","baseBranch":"main","branch":"seekcloud/a","access":"push"}],"model":"deepseek/x","effort":"high","environmentName":"","pinnedAt":null,"groupId":null,"sortKey":1,"unread":false,"createdAt":"t","updatedAt":"t","newField":1}],"groups":[{"id":"g","name":"G","sortKey":1}]}""",
        )
        assertTrue(state.loaded)
        assertEquals(listOf("a"), state.sessions.map { it.shortId })
        assertEquals("acme/a", state.sessions[0].repos[0].fullName)
        state = state.apply("session", """{"shortId":"a","title":"A2","status":"waiting","createdAt":"t","updatedAt":"t2"}""")
        assertEquals("A2", state.sessions.single().title)
        state = state.apply("session", """{"shortId":"b","title":"B","status":"queued","createdAt":"t","updatedAt":"t"}""")
        assertEquals(listOf("a", "b"), state.sessions.map { it.shortId })
        state = state.apply("removed", """{"shortId":"a"}""")
        assertEquals(listOf("b"), state.sessions.map { it.shortId })
        state = state.apply("groups", """{"groups":[]}""")
        assertTrue(state.groups.isEmpty())
        // 读不懂的不改
        assertEquals(state, state.apply("session", "not json"))
        assertEquals(state, state.apply("something_new", "{}"))
        // 重连以后的 snapshot 整个换掉
        state = state.apply("snapshot", """{"sessions":[],"groups":[]}""")
        assertTrue(state.sessions.isEmpty())
    }
}
