package cn.seekcloud.app.sessions

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 会话列表里的一个会话（#124）：只读列表要用的几项。主站加了字段不影响；状态是字符串，
 * 主站以后加了新的状态也不会读不出来（按不认得的处理）。
 */
@Serializable
data class SessionSummary(
    val shortId: String,
    val title: String,
    val status: String,
    val detail: String? = null,
    val repos: List<SessionRepo> = emptyList(),
    val pinnedAt: String? = null,
    val groupId: String? = null,
    val sortKey: Double = 0.0,
    val unread: Boolean = false,
    val createdAt: String,
    val updatedAt: String,
    /** "提供方/模型"和思考强度（会话页的会话信息、换模型时用）。 */
    val model: String = "",
    val effort: String = "",
    /** 会话用的环境的名字；环境被删掉了时为 null；默认环境是空字符串（界面按语言显示名字）。 */
    val environmentName: String? = null,
)

/** 会话的一个仓库：第一个是主仓库。[pullRequest] 是会话分支上最近的 PR。 */
@Serializable
data class SessionRepo(
    val fullName: String,
    val baseBranch: String = "",
    val branch: String = "",
    val access: String = "push",
    val pullRequest: PullRequestRef? = null,
)

@Serializable
data class PullRequestRef(val number: Int, val state: String)

/** 侧栏的分组（#153），分组之间按 sortKey 从小到大排。 */
@Serializable
data class SessionGroup(val id: String, val name: String, val sortKey: Double = 0.0)

/** 会话列表从上到下（照网页的侧栏，client/session/sidebar-sections.ts）：置顶、各个分组、"最近"，已归档的在最下面。 */
data class Sections(
    val pinned: List<SessionSummary>,
    val groups: List<Pair<SessionGroup, List<SessionSummary>>>,
    val recent: List<SessionSummary>,
    val archived: List<SessionSummary>,
)

private val bySortKey = compareByDescending<SessionSummary> { it.sortKey }.thenByDescending { it.createdAt }

/**
 * 把会话分到几类里，和网页一样：每一类里按 sortKey 从大到小。搜索时不分类，标题或仓库名里有搜的字的都放在"最近"里，
 * 按最近有动静的排。分组没了（别处删了、还没收到推送）的会话先放在"最近"里。
 */
fun sections(sessions: List<SessionSummary>, groups: List<SessionGroup>, query: String = ""): Sections {
    val q = query.trim().lowercase()
    if (q.isNotEmpty()) {
        val recent = sessions
            .filter { s -> s.title.lowercase().contains(q) || s.repos.any { it.fullName.lowercase().contains(q) } }
            .sortedByDescending { it.updatedAt }
        return Sections(emptyList(), emptyList(), recent, emptyList())
    }
    val live = sessions.filter { it.status != "archived" }
    val known = groups.map { it.id }.toSet()
    return Sections(
        pinned = live.filter { it.pinnedAt != null }.sortedWith(bySortKey),
        groups = groups.sortedBy { it.sortKey }.map { group ->
            group to live.filter { it.pinnedAt == null && it.groupId == group.id }.sortedWith(bySortKey)
        },
        recent = live.filter { it.pinnedAt == null && (it.groupId == null || it.groupId !in known) }.sortedWith(bySortKey),
        archived = sessions.filter { it.status == "archived" },
    )
}

/** 会话右边的标记（规格 #138 的顺序，取第一个符合的，照网页的 statusMark）。 */
enum class StatusMark { Failed, Running, Awaiting, Unread }

fun statusMark(session: SessionSummary): StatusMark? = when {
    session.status == "failed" -> StatusMark.Failed
    session.status == "running" || session.status == "queued" -> StatusMark.Running
    session.detail == "awaiting_input" && session.status != "archived" -> StatusMark.Awaiting
    session.unread -> StatusMark.Unread
    else -> null
}

/** 会话列表现在的内容。[loaded] 是收到过主站的第一份列表。 */
data class SessionListState(
    val sessions: List<SessionSummary> = emptyList(),
    val groups: List<SessionGroup> = emptyList(),
    val loaded: Boolean = false,
)

@Serializable
private data class Snapshot(val sessions: List<SessionSummary> = emptyList(), val groups: List<SessionGroup> = emptyList())

@Serializable
private data class Removed(val shortId: String)

@Serializable
private data class Groups(val groups: List<SessionGroup> = emptyList())

private val json = Json { ignoreUnknownKeys = true }

/**
 * 收到会话列表事件流（`/api/sessions/stream`）的一条以后，列表变成什么样：
 * - `snapshot`：连上（包括重连）时的全部会话和分组，整个换掉；
 * - `session`：一个会话的最新内容，有就换、没有就加；
 * - `removed`：会话被删了，拿掉；
 * - `groups`：全部分组。
 * 读不懂的事件不改列表。
 */
fun SessionListState.apply(event: String, data: String): SessionListState = runCatching {
    when (event) {
        "snapshot" -> json.decodeFromString<Snapshot>(data).let { SessionListState(it.sessions, it.groups, loaded = true) }
        "session" -> {
            val session = json.decodeFromString<SessionSummary>(data)
            val index = sessions.indexOfFirst { it.shortId == session.shortId }
            copy(sessions = if (index < 0) sessions + session else sessions.toMutableList().also { it[index] = session })
        }
        "removed" -> {
            val id = json.decodeFromString<Removed>(data).shortId
            copy(sessions = sessions.filter { it.shortId != id })
        }
        "groups" -> copy(groups = json.decodeFromString<Groups>(data).groups)
        else -> this
    }
}.getOrDefault(this)
