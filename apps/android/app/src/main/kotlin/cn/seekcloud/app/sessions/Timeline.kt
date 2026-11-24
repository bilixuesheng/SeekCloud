package cn.seekcloud.app.sessions

import kotlinx.serialization.json.JsonElement

/**
 * 会话页的时间线（#182），规则照网页的 timeline.ts：把落了库的事件整理成界面上的一条条内容。
 * 提示的文字不在这里写，只记是哪一种提示和要用的参数，界面按系统语言挑文案。
 */
data class Timeline(
    val items: List<TimelineItem> = emptyList(),
    /** 最新的状态；还没收到状态事件时为 null。 */
    val status: String? = null,
    val detail: String? = null,
    /** 进入最新状态的时间，用来显示"已经运行了多久"。 */
    val since: String? = null,
    /** Agent 工作时发的、还在排队的消息，按发的顺序。 */
    val queued: List<QueuedMessage> = emptyList(),
    /** 正在运行的工具调用；没有工具在跑（模型在想、在写）时为 null。 */
    val activity: ToolCallItem? = null,
    /** 这个回合的计划（待办清单最新的一份）；回合结束以后就没有了。 */
    val plan: Plan? = null,
)

data class QueuedMessage(val id: String, val text: String)

/** [stale]：计划最后一次更新以后管理员又发了消息，标题写"你上一条消息之前的计划"。 */
data class Plan(val items: List<TodoItem>, val stale: Boolean)

data class ToolCallItem(val key: Int, val name: String, val input: JsonElement, val result: ToolOutcome? = null)

data class ToolOutcome(val output: String, val isError: Boolean)

/** 一个回合改了的文件（改动卡片）：只有改了文件的仓库。 */
data class TurnChanges(val repos: List<RepoOutcome>)

/** 回合结束时最后一条回复下面的一行：[reply] 是这个回合全部回复的原文（复制用），[at] 是结束的时间。 */
data class TurnEnd(val reply: String, val at: String, val changes: TurnChanges? = null)

sealed interface TimelineItem {
    val key: Int

    /** 管理员的消息。[delivered]：已经交给 Agent（所在的回合开始了，或者是插话）。 */
    data class User(override val key: Int, val text: String, val at: String, val delivered: Boolean) : TimelineItem

    /** Agent 的回复。[turnEnd] 不为 null：这是回合里最后一条回复，回合已经结束。 */
    data class Assistant(override val key: Int, val text: String, val thinking: String? = null, val turnEnd: TurnEnd? = null) : TimelineItem

    /** 回合里没有回复、但改了文件：改动卡片单独放。 */
    data class Changes(override val key: Int, val changes: TurnChanges) : TimelineItem

    /** 连续的工具调用合成一组。 */
    data class Tools(override val key: Int, val calls: List<ToolCallItem>) : TimelineItem

    data class Notice(override val key: Int, val notice: TimelineNotice) : TimelineItem

    data class ModelSwitch(override val key: Int, val model: String, val effort: String) : TimelineItem
}

/** 时间线上一行提示是哪一种。 */
sealed interface TimelineNotice {
    val error: Boolean

    /** 推送会话分支失败，平台把错误交给 Agent 处理。 */
    data object PushFollowUp : TimelineNotice {
        override val error = false
    }

    data class PushGaveUp(val repos: List<String>) : TimelineNotice {
        override val error = true
    }

    data class TurnStopped(val cause: SafeError?) : TimelineNotice {
        override val error = false
    }

    data class TurnFailed(val cause: SafeError?) : TimelineNotice {
        override val error = true
    }

    data class SessionFailed(val cause: SafeError?) : TimelineNotice {
        override val error = true
    }
}

fun buildTimeline(events: List<SessionEvent>): Timeline {
    val items = mutableListOf<TimelineItem>()
    // 工具调用的结果晚到：先放进去，结果来了换成带结果的
    val calls = LinkedHashMap<String, Pair<Int, Int>>() // callId → (items 里的位置, 组里的位置)
    var status: String? = null
    var detail: String? = null
    var since: String? = null
    var queued = mutableListOf<QueuedMessage>()
    // 还没交给 Agent 的用户消息（items 里的位置）：回合开始时一起标成已交付
    var undelivered = mutableListOf<Int>()
    // 当前回合里 Agent 的回复（items 里的位置）
    var replies = mutableListOf<Int>()
    var running = LinkedHashMap<String, Unit>()
    var plan: Plan? = null
    // 改动卡片：workspace 在 turn.ended 前面到，先记下；停止的回合晚到，挂回那个回合的最后一条回复
    val pendingChanges = HashMap<Int, TurnChanges>()
    val endedTurns = HashMap<Int, Int?>() // 回合 → 最后一条回复在 items 里的位置（没有回复为 null）

    fun tool(callId: String): ToolCallItem? = calls[callId]?.let { (i, j) -> (items[i] as TimelineItem.Tools).calls[j] }

    for (event in events) {
        when (event) {
            is SessionEvent.UserMessage -> {
                if (event.followUp != null) {
                    items += TimelineItem.Notice(event.seq, TimelineNotice.PushFollowUp)
                    continue
                }
                event.queued?.let { ids -> queued = queued.filterNot { it.id in ids }.toMutableList() }
                val delivered = event.injected
                if (!delivered) undelivered += items.size
                items += TimelineItem.User(event.seq, event.text, event.at, delivered)
                plan = plan?.copy(stale = true)
            }
            is SessionEvent.TurnStarted -> {
                for (i in undelivered) items[i] = (items[i] as TimelineItem.User).copy(delivered = true)
                undelivered = mutableListOf()
                replies = mutableListOf()
                running = LinkedHashMap()
            }
            is SessionEvent.MessageQueued -> queued += QueuedMessage(event.id, event.text)
            is SessionEvent.MessageWithdrawn -> queued = queued.filterNot { it.id == event.id }.toMutableList()
            is SessionEvent.Message -> {
                replies += items.size
                items += TimelineItem.Assistant(event.seq, event.text, event.thinking?.takeIf { it.isNotEmpty() })
            }
            is SessionEvent.ToolCall -> {
                val call = ToolCallItem(event.seq, event.name, event.input)
                val last = items.lastOrNull()
                if (last is TimelineItem.Tools) {
                    calls[event.callId] = items.lastIndex to last.calls.size
                    items[items.lastIndex] = last.copy(calls = last.calls + call)
                } else {
                    calls[event.callId] = items.size to 0
                    items += TimelineItem.Tools(event.seq, listOf(call))
                }
                running[event.callId] = Unit
            }
            is SessionEvent.ToolResult -> {
                calls[event.callId]?.let { (i, j) ->
                    val group = items[i] as TimelineItem.Tools
                    val updated = group.calls.toMutableList()
                    updated[j] = updated[j].copy(result = ToolOutcome(event.output, event.isError))
                    items[i] = group.copy(calls = updated)
                }
                running.remove(event.callId)
            }
            is SessionEvent.Todo -> plan = Plan(event.items, stale = false)
            is SessionEvent.Workspace -> {
                val changes = turnChanges(event.repos) ?: continue
                val turn = event.turn ?: continue
                if (turn !in endedTurns) {
                    pendingChanges[turn] = changes
                    continue
                }
                val reply = endedTurns[turn]
                val item = reply?.let { items[it] as TimelineItem.Assistant }
                if (item?.turnEnd != null) {
                    items[reply] = item.copy(turnEnd = item.turnEnd.copy(changes = changes))
                } else {
                    items += TimelineItem.Changes(event.seq, changes)
                }
            }
            is SessionEvent.PushGaveUp -> items += TimelineItem.Notice(event.seq, TimelineNotice.PushGaveUp(event.repos))
            is SessionEvent.ModelChanged -> items += TimelineItem.ModelSwitch(event.seq, event.model, event.effort)
            is SessionEvent.TurnEnded -> {
                val last = replies.lastOrNull()
                val changes = event.turn?.let { pendingChanges[it] }
                var ended: Int? = null
                if (last != null) {
                    val reply = replies.map { (items[it] as TimelineItem.Assistant).text }.filter { it.isNotBlank() }.joinToString("\n\n")
                    if (reply.isNotEmpty()) {
                        items[last] = (items[last] as TimelineItem.Assistant).copy(turnEnd = TurnEnd(reply, event.at, changes))
                        ended = last
                    }
                }
                if (changes != null && ended == null) items += TimelineItem.Changes(event.seq, changes)
                event.turn?.let { endedTurns[it] = ended }
                replies = mutableListOf()
                running = LinkedHashMap()
                plan = null
                when (event.reason) {
                    "stopped" -> items += TimelineItem.Notice(event.seq, TimelineNotice.TurnStopped(event.error))
                    "failed" -> items += TimelineItem.Notice(event.seq, TimelineNotice.TurnFailed(event.error))
                }
            }
            is SessionEvent.Status -> {
                if (event.status != status) since = event.at
                status = event.status
                detail = event.detail
                if (event.status == "failed") items += TimelineItem.Notice(event.seq, TimelineNotice.SessionFailed(event.error))
            }
            is SessionEvent.Unknown -> Unit
        }
    }
    return Timeline(
        items = items,
        status = status,
        detail = detail,
        since = since,
        queued = queued,
        activity = running.keys.lastOrNull()?.let(::tool),
        plan = plan,
    )
}

/** 改动卡片的内容：只留改了文件的仓库；都没改就没有卡片。 */
private fun turnChanges(repos: List<RepoOutcome>): TurnChanges? =
    repos.filter { it.files.isNotEmpty() || it.omittedFiles > 0 }.takeIf { it.isNotEmpty() }?.let(::TurnChanges)

/**
 * 宿主机推来的文字增量拼成的一条临时回复（逐字输出，只推送、不落库）。[key] 是负数，不会和事件的序号撞上。
 * 这一步完整的消息到了就由它接过去，界面用同一个 key 画，字接着显示、不重播。
 */
data class Draft(val key: Int, val text: String, val thinking: String = "")

/** 收到一条落库的事件以后临时回复怎么办（照网页的 useSessionEvents）：[adopted] 是接过临时回复的那条消息用的 key。 */
data class Settled(val draft: Draft?, val adopted: Int? = null)

fun settleDraft(draft: Draft?, event: SessionEvent, nextKey: () -> Int): Settled {
    if (draft == null) return Settled(null)
    return when (event) {
        is SessionEvent.Message -> when {
            event.text.startsWith(draft.text) -> Settled(null, draft.key)
            // 下一步的增量比这一步的完整消息先到了：前面这段交给这条消息，多出来的留着
            draft.text.startsWith(event.text) -> Settled(Draft(nextKey(), draft.text.substring(event.text.length)), draft.key)
            else -> Settled(null)
        }
        is SessionEvent.ToolCall, is SessionEvent.TurnStarted, is SessionEvent.TurnEnded -> Settled(null)
        else -> Settled(draft)
    }
}
