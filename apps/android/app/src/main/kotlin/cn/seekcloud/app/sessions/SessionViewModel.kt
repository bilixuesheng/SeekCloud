package cn.seekcloud.app.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.EventStreamClosed
import cn.seekcloud.app.net.SseEvent
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException

/** 连上以后这么久没有新事件，就当历史已经补完了（照网页）。 */
private const val HISTORY_QUIET_MS = 250L
/** 历史最多补这么久；一直有事件进来时，到点也算补完。 */
private const val HISTORY_MAX_MS = 1500L

/** 会话页的内容：整理好的时间线和逐字输出的临时回复，两样一起换（不会有一下两条都在、或者都不在）。 */
data class SessionPage(
    val timeline: Timeline = Timeline(),
    /** 序号比它大的是打开会话以后才发生的（回复的字一个个出来）；历史还没补完时是最大值，一条都不算新的。 */
    val liveAfter: Int = Int.MAX_VALUE,
    val draft: Draft? = null,
    /** 第几号事件接过了哪条临时回复：界面用同一个 key 画，字接着显示、不重播。 */
    val adopted: Map<Int, Int> = emptyMap(),
    val progress: ModelProgress? = null,
    /** 发过的消息条数（用户消息和排队的消息）：刚发出去的那条等服务器回推以后换成正式的。 */
    val sentCount: Int = 0,
    /** 第一次连上、历史补完了没有。 */
    val loaded: Boolean = false,
)

/** 刚发出去、服务器还没回推的消息：先显示出来，不让人等一个来回。[after] 是发的时候已经有几条。 */
data class PendingMessage(val text: String, val after: Int, val at: String)

/** 排队的消息上正在做的操作。 */
enum class QueueAction { Restore, Delete, SendNow }

data class ComposerUi(
    val text: String = "",
    val pending: PendingMessage? = null,
    val busy: Boolean = false,
    val stopping: Boolean = false,
    val queue: Map<String, QueueAction> = emptyMap(),
    val failure: Throwable? = null,
)

/**
 * 会话页（#182）：连着这个会话的事件流（App 在前台时），把事件整理成时间线；发消息、停止、排队的消息撤回和立即发送。
 * 断了自动重连，从最后一个序号接着补，不缺不重复；切到后台再回来也一样。设备被退出了（401）交给 [onSignedOut]。
 */
class SessionViewModel(
    val shortId: String,
    private val api: SessionPageApi,
    private val actions: SessionActions,
    /** 订阅事件流：[lastEventId] 是最后收到的序号。 */
    private val stream: (lastEventId: String?, onConnected: (Boolean) -> Unit) -> Flow<SseEvent>,
    private val onSignedOut: () -> Unit,
    private val now: () -> Instant = Instant::now,
    /** 调接口用的线程；整理时间线用的线程（测试里换成测试的调度器）。 */
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val work: CoroutineDispatcher = Dispatchers.Default,
    /** 回复里的图片怎么加载；主站的主机名（主站自己的图片直接显示）。 */
    val images: ImageLoader? = null,
    val serverHost: String? = null,
) : ViewModel() {
    private val _page = MutableStateFlow(SessionPage())
    val page: StateFlow<SessionPage> = _page.asStateFlow()

    private val _composer = MutableStateFlow(ComposerUi())
    val composer: StateFlow<ComposerUi> = _composer.asStateFlow()

    private val _connected = MutableStateFlow(true)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    /** 会话不在了（删了、链接不对）。 */
    private val _missing = MutableStateFlow(false)
    val missing: StateFlow<Boolean> = _missing.asStateFlow()

    /** 打开时取一次的会话（会话列表里没有时用它的标题）。 */
    private val _session = MutableStateFlow<SessionSummary?>(null)
    val session: StateFlow<SessionSummary?> = _session.asStateFlow()

    private val events = ArrayList<SessionEvent>()
    private var lastSeq = 0
    private var current: Draft? = null
    private var nextKey = -1
    private val adopted = HashMap<Int, Int>()
    private var caughtUp = false
    private var quiet: Job? = null
    private var deadline: Job? = null
    private var rebuilding = false
    private var rebuildAgain = false
    private var everConnected = false
    private var job: Job? = null

    init {
        viewModelScope.launch {
            try {
                val session = withContext(io) { api.session(shortId) }
                _session.value = session
                // 打开会话就把"有新内容"消掉（照网页：每次打开只看一次）
                if (session.unread) withContext(io) { actions.setUnread(shortId, false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 401) onSignedOut()
                if (e.status == 404) _missing.value = true
            } catch (_: Exception) {
                // 连不上：事件流会自己重连，标题先用会话列表里的
            }
        }
    }

    /** App 在前台、页面开着时连上事件流。 */
    fun start() {
        job?.cancel()
        job = viewModelScope.launch {
            try {
                stream(lastSeq.takeIf { it > 0 }?.toString(), ::onConnected).collect(::receive)
            } catch (e: EventStreamClosed) {
                if (e.status == 401) onSignedOut()
                if (e.status == 404) _missing.value = true
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun onConnected(connected: Boolean) {
        viewModelScope.launch {
            _connected.value = connected
            if (!connected) return@launch
            if (everConnected) {
                // 断开期间的增量没有补发：临时回复作废，等完整的消息
                if (current != null) {
                    current = null
                    publishDraft()
                }
                return@launch
            }
            everConnected = true
            // 断线重连时补发的是断开期间的新事件，不是历史，所以只在第一次连上时等
            deadline = viewModelScope.launch {
                delay(HISTORY_MAX_MS)
                catchUp()
            }
            waitQuiet()
        }
    }

    private fun receive(event: SseEvent) {
        when (event.event) {
            "session" -> {
                val parsed = parseSessionEvent(event.data) ?: return
                if (parsed.seq <= lastSeq) return
                lastSeq = parsed.seq
                val settled = settleDraft(current, parsed) { nextKey-- }
                current = settled.draft
                settled.adopted?.let { adopted[parsed.seq] = it }
                events += parsed
                val progressReset = parsed is SessionEvent.TurnStarted || parsed is SessionEvent.TurnEnded
                if (progressReset) _page.update { it.copy(progress = null) }
                rebuild()
                waitQuiet()
            }
            "delta" -> {
                val delta = parseDelta(event.data) ?: return
                val draft = current ?: Draft(nextKey--, "")
                current = if (delta.kind == "text") draft.copy(text = draft.text + delta.text) else draft.copy(thinking = draft.thinking + delta.text)
                if (!rebuilding) publishDraft()
            }
            "progress" -> parseProgress(event.data)?.let { p -> _page.update { it.copy(progress = p) } }
        }
    }

    private fun publishDraft() {
        _page.update { it.copy(draft = current) }
    }

    /** 重新整理时间线（在后台线程，几千条事件也不卡界面）。整理期间又来了事件，整理完再来一遍。 */
    private fun rebuild() {
        if (rebuilding) {
            rebuildAgain = true
            return
        }
        rebuilding = true
        viewModelScope.launch {
            try {
                do {
                    rebuildAgain = false
                    val snapshot = events.toList()
                    val timeline = withContext(work) { buildTimeline(snapshot) }
                    val sent = snapshot.count { it is SessionEvent.UserMessage || it is SessionEvent.MessageQueued }
                    _page.update {
                        it.copy(timeline = timeline, draft = current, adopted = HashMap(adopted), sentCount = sent)
                    }
                    // 服务器回推了刚才先显示的那条：换成正式的
                    _composer.update { c -> if (c.pending != null && sent > c.pending.after) c.copy(pending = null) else c }
                } while (rebuildAgain)
            } finally {
                rebuilding = false
            }
        }
    }

    private fun waitQuiet() {
        if (caughtUp || !everConnected) return
        quiet?.cancel()
        quiet = viewModelScope.launch {
            delay(HISTORY_QUIET_MS)
            catchUp()
        }
    }

    private fun catchUp() {
        if (caughtUp) return
        caughtUp = true
        quiet?.cancel()
        deadline?.cancel()
        _page.update { it.copy(liveAfter = lastSeq, loaded = true) }
    }

    fun setText(text: String) {
        _composer.update { it.copy(text = text) }
    }

    /**
     * 发一条消息。[fromComposer]：从输入框发的，发出去清空输入框，没发出去把字还回去；重试不动输入框。
     * Agent 在工作时 [mode] 为 now 插进当前回合，later 排队到回合结束。
     */
    fun send(text: String = _composer.value.text, fromComposer: Boolean = true, mode: String = "now") {
        if (text.isBlank() || _composer.value.busy) return
        _composer.update {
            it.copy(
                busy = true,
                failure = null,
                pending = PendingMessage(text, _page.value.sentCount, now().toString()),
                text = if (fromComposer) "" else it.text,
            )
        }
        viewModelScope.launch {
            try {
                withContext(io) { api.send(shortId, text, mode) }
                _composer.update { it.copy(busy = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiException && e.status == 401) onSignedOut()
                // 没发出去：气泡收回，字还给输入框（输入框里这时又打了字的，接在前面）
                _composer.update {
                    it.copy(
                        busy = false,
                        pending = null,
                        failure = e,
                        text = if (fromComposer) listOf(text, it.text).filter(String::isNotEmpty).joinToString("\n") else it.text,
                    )
                }
            }
        }
    }

    /** 停下回合：只停回合，输入框里的字不动（照 Claude）。 */
    fun stopTurn() {
        if (_composer.value.stopping) return
        _composer.update { it.copy(stopping = true, failure = null) }
        perform({ api.stop(shortId) }) { _composer.update { it.copy(stopping = false) } }
    }

    /** 撤回一条排队的消息；[restore] 为真时字放回输入框（撤回并编辑），否则直接删掉。 */
    fun withdraw(queueId: String, restore: Boolean) = queueAction(queueId, if (restore) QueueAction.Restore else QueueAction.Delete) {
        val text = api.withdraw(shortId, queueId)
        if (restore && !text.isNullOrEmpty()) {
            _composer.update { c -> c.copy(text = if (c.text.isEmpty()) text else "$text\n${c.text}") }
        }
    }

    fun sendNow(queueId: String) = queueAction(queueId, QueueAction.SendNow) { api.sendNow(shortId, queueId) }

    /** 取消归档（之后发消息就唤醒）。 */
    fun unarchive() = perform({ actions.unarchive(shortId) }) {}

    fun dismissFailure() {
        _composer.update { it.copy(failure = null) }
    }

    private fun queueAction(queueId: String, action: QueueAction, block: () -> Unit) {
        if (queueId in _composer.value.queue) return
        _composer.update { it.copy(queue = it.queue + (queueId to action), failure = null) }
        perform(block) { _composer.update { it.copy(queue = it.queue - queueId) } }
    }

    /** 在后台做一件事；失败了显示原因，设备被退出了回登录页。[finally] 不管成败都做。 */
    private fun perform(block: () -> Unit, finally: () -> Unit) {
        viewModelScope.launch {
            try {
                withContext(io) { block() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiException && e.status == 401) onSignedOut()
                _composer.update { it.copy(failure = e) }
            } finally {
                finally()
            }
        }
    }
}
