package cn.seekcloud.app.ui

import android.content.ClipData
import android.provider.Settings
import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import cn.seekcloud.app.sessions.ChangesPanelUi
import cn.seekcloud.app.sessions.DiffFile
import cn.seekcloud.app.sessions.MessagePin
import cn.seekcloud.app.sessions.PatchLine
import cn.seekcloud.app.sessions.RepoDiff
import cn.seekcloud.app.sessions.patchLines
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.seekcloud.app.R
import cn.seekcloud.app.net.errorTexts
import cn.seekcloud.app.net.failureText
import cn.seekcloud.app.sessions.ComposerUi
import cn.seekcloud.app.sessions.FileChange
import cn.seekcloud.app.sessions.ModelList
import cn.seekcloud.app.sessions.ModelProgress
import cn.seekcloud.app.sessions.PACED_TICK_MS
import cn.seekcloud.app.sessions.Plan
import cn.seekcloud.app.sessions.QueueAction
import cn.seekcloud.app.sessions.QueuedMessage
import cn.seekcloud.app.sessions.SafeError
import cn.seekcloud.app.sessions.SessionPage
import cn.seekcloud.app.sessions.SessionSummary
import cn.seekcloud.app.sessions.SessionViewModel
import cn.seekcloud.app.sessions.TimelineItem
import cn.seekcloud.app.sessions.TimelineNotice
import cn.seekcloud.app.sessions.ToolCallItem
import cn.seekcloud.app.sessions.TurnChanges
import cn.seekcloud.app.sessions.cutMap
import cn.seekcloud.app.sessions.nextCut
import cn.seekcloud.app.sessions.pacedStep
import cn.seekcloud.app.sessions.toolInputText
import cn.seekcloud.app.sessions.toolSummary
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 会话页（#182）：消息、思考、工具调用、计划，底下是输入框。App 在前台时连着这个会话的事件流。 */
@Composable
fun SessionRoute(
    listed: SessionSummary?,
    viewModel: SessionViewModel,
    onBack: (() -> Unit)?,
    /** 打开会话菜单（和会话列表里长按的是同一个）。 */
    onMenu: (() -> Unit)? = null,
) {
    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    val page by viewModel.page.collectAsStateWithLifecycle()
    val composer by viewModel.composer.collectAsStateWithLifecycle()
    val connected by viewModel.connected.collectAsStateWithLifecycle()
    val missing by viewModel.missing.collectAsStateWithLifecycle()
    val fetched by viewModel.session.collectAsStateWithLifecycle()
    val models by viewModel.models.collectAsStateWithLifecycle()
    val choice by viewModel.choice.collectAsStateWithLifecycle()
    val pins by viewModel.pins.collectAsStateWithLifecycle()
    val changes by viewModel.changes.collectAsStateWithLifecycle()
    val session = listed ?: fetched
    val markdown = MarkdownEnv(viewModel.images, viewModel.serverHost, session?.repos?.firstOrNull()?.fullName)
    CompositionLocalProvider(LocalMarkdownEnv provides markdown) {
        SessionScreen(
            title = session?.title.orEmpty(),
            session = session,
            models = models,
            choice = choice,
            onChoose = viewModel::choose,
            onMenu = onMenu,
            pins = pins,
            onPin = viewModel::togglePin,
            changes = changes,
            onOpenChanges = viewModel::openChanges,
            onCloseChanges = viewModel::closeChanges,
            fallbackStatus = session?.status,
            page = page,
            composer = composer,
            connected = connected,
            missing = missing,
            onBack = onBack,
            onText = viewModel::setText,
            onSend = { mode -> viewModel.send(mode = mode) },
            onRetry = { viewModel.send(it, fromComposer = false) },
            onStop = viewModel::stopTurn,
            onWithdraw = viewModel::withdraw,
            onSendNow = viewModel::sendNow,
            onUnarchive = viewModel::unarchive,
            onDismissFailure = viewModel::dismissFailure,
        )
    }
}

/** 时间线上的一行：key 在整个列表里唯一，换内容时界面上的状态（字显示到哪了、展开没有）跟着它走。 */
private sealed interface Entry {
    val key: String

    data class Item(val item: TimelineItem, override val key: String, val live: Boolean) : Entry
    data class Queued(val message: QueuedMessage, val first: Boolean) : Entry {
        override val key = "queued:${message.id}"
    }
    data class Pending(val text: String, val at: String) : Entry {
        override val key = "pending"
    }
    data class PlanCard(val plan: Plan) : Entry {
        override val key = "plan"
    }
    data class Working(val text: String, val ellipsis: Boolean, val since: String?, val progress: ModelProgress?) : Entry {
        override val key = "tail"
    }
    data object Tail : Entry {
        override val key = "tail"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
    title: String,
    fallbackStatus: String?,
    session: SessionSummary? = null,
    models: ModelList? = null,
    choice: Pair<String, String>? = null,
    onChoose: (String, String) -> Unit = { _, _ -> },
    onMenu: (() -> Unit)? = null,
    pins: List<MessagePin> = emptyList(),
    onPin: (Int, Boolean) -> Unit = { _, _ -> },
    changes: ChangesPanelUi? = null,
    onOpenChanges: (String?) -> Unit = {},
    onCloseChanges: () -> Unit = {},
    page: SessionPage,
    composer: ComposerUi,
    connected: Boolean,
    missing: Boolean,
    onBack: (() -> Unit)?,
    onText: (String) -> Unit,
    onSend: (mode: String) -> Unit,
    onRetry: (String) -> Unit,
    onStop: () -> Unit,
    onWithdraw: (id: String, restore: Boolean) -> Unit,
    onSendNow: (String) -> Unit,
    onUnarchive: () -> Unit,
    onDismissFailure: () -> Unit,
) {
    if (onBack != null) BackHandler(onBack = onBack)
    var info by rememberSaveable { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var picking by rememberSaveable { mutableStateOf(false) }
    val nameOf = { id: String -> models?.models?.firstOrNull { it.id == id }?.let { modelName(it) } ?: id.substringAfter('/') }
    val timeline = page.timeline
    val status = timeline.status ?: fallbackStatus
    val working = status == "running" || status == "queued"
    val closed = status == "archived"
    val canRetry = !composer.busy && !closed && !working

    val activity = timeline.activity
    val preparing = timeline.detail == "preparing_sandbox"
    val workingText = when {
        status == "queued" -> stringResource(R.string.chat_queued_waiting)
        preparing -> stringResource(R.string.status_preparing_sandbox)
        activity != null -> listOf(toolLabel(activity.name), firstLine(toolSummary(activity.input))).filter { it.isNotEmpty() }.joinToString(" ")
        else -> stringResource(R.string.chat_seeking)
    }
    val entries = buildList {
        val items = timeline.items + listOfNotNull(
            page.draft?.takeIf { it.text.isNotEmpty() }?.let { TimelineItem.Assistant(it.key, it.text, it.thinking.ifEmpty { null }) },
        )
        for (item in items) {
            val key = page.adopted[item.key] ?: item.key
            add(Entry.Item(item, "item:$key", live = item.key < 0 || item.key > page.liveAfter))
        }
        timeline.queued.forEachIndexed { i, q -> add(Entry.Queued(q, first = i == 0)) }
        val pending = composer.pending
        if (pending != null && page.sentCount <= pending.after) add(Entry.Pending(pending.text, pending.at))
        if (working) timeline.plan?.let { add(Entry.PlanCard(it)) }
        when {
            working -> add(
                Entry.Working(
                    workingText,
                    // 有工具在跑时写它在做什么（不加省略号），不显示 token 数（照网页）
                    ellipsis = activity == null || preparing || status == "queued",
                    since = timeline.since,
                    progress = if (activity == null && status == "running") page.progress else null,
                ),
            )
            items.any { it is TimelineItem.Assistant } -> add(Entry.Tail)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    // 点标题打开会话菜单（照网页的标题菜单）
                    val menuLabel = stringResource(R.string.session_menu)
                    Row(
                        Modifier
                            .then(if (onMenu != null) Modifier.clickable(onClickLabel = menuLabel, onClick = onMenu) else Modifier)
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (onMenu != null) Icon(painterResource(R.drawable.ic_expand_more), contentDescription = menuLabel, modifier = Modifier.size(20.dp))
                    }
                },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = stringResource(R.string.common_back))
                        }
                    }
                },
                actions = {
                    if (pins.isNotEmpty()) {
                        PinNav(pins) { seq ->
                            // 滚到那条回复（会话开头是列表的最上面）
                            val target = if (seq == null) "" else "item:${page.adopted[seq] ?: seq}"
                            val index = if (seq == null) entries.size - 1 else entries.indexOfFirst { it.key == target }
                            if (index >= 0) scope.launch { listState.revealTop(entries.size - 1 - index) }
                        }
                    }
                    if (session != null) {
                        IconButton(onClick = { info = true }) {
                            Icon(painterResource(R.drawable.ic_info), contentDescription = stringResource(R.string.session_info))
                        }
                    }
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        if (missing) {
            Column(
                Modifier.padding(padding).fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(stringResource(R.string.chat_not_found), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.chat_not_found_hint), textAlign = TextAlign.Center)
            }
            return@Scaffold
        }
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            if (!connected) {
                Text(
                    stringResource(R.string.sessions_offline),
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.secondaryContainer)
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val actions = TimelineActions(
                    openChanges = onOpenChanges,
                    undo = onRetry.takeIf { canRetry },
                    pins = pins.associateBy { it.seq },
                    pin = onPin,
                )
                CompositionLocalProvider(LocalTimelineActions provides actions) {
                    Conversation(entries, listState, onRetry = onRetry.takeIf { canRetry }, onWithdraw, onSendNow, composer.queue, nameOf)
                }
            }
            composer.failure?.let {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { Notice(failureText(it, LocalResources.current.errorTexts()), error = true) }
                    IconButton(onClick = onDismissFailure) {
                        Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.common_close))
                    }
                }
            }
            if (closed) ArchivedNote(onUnarchive)
            Composer(
                text = composer.text,
                onText = onText,
                placeholder = stringResource(
                    when (status) {
                        "archived" -> R.string.chat_placeholder_archived
                        "failed" -> R.string.chat_placeholder_failed
                        else -> R.string.chat_placeholder
                    },
                ),
                enabled = !closed,
                busy = composer.busy,
                working = working,
                stopping = composer.stopping,
                onSend = onSend,
                onStop = onStop,
            )
            // 输入框下面：模型和思考强度，换了从下一条消息起生效（照网页的 composer-below）
            val picked = choice ?: session?.let { it.model to it.effort }
            val current = picked?.let { (id, _) -> models?.models?.firstOrNull { it.id == id } }
            if (models != null && picked != null && !closed) {
                val name = current?.let { modelName(it) } ?: picked.first.substringAfter('/')
                val label = if (current?.efforts?.isNotEmpty() == true) "$name · ${effortName(picked.second)}" else name
                val chooseLabel = stringResource(R.string.model_choose, name)
                TextButton(
                    onClick = { picking = true },
                    modifier = Modifier.padding(start = 12.dp, bottom = 4.dp).semantics { contentDescription = chooseLabel },
                ) {
                    Text(label, style = MaterialTheme.typography.labelLarge)
                    Icon(painterResource(R.drawable.ic_expand_more), contentDescription = null, modifier = Modifier.size(18.dp))
                }
                if (picking) {
                    ModelSheet(
                        models = models,
                        model = picked.first,
                        effort = picked.second,
                        onChange = onChoose,
                        onDismiss = { picking = false },
                    )
                }
            }
        }
    }
    changes?.let { ChangesPanel(it, onCloseChanges) }
    if (info && session != null) SessionInfoSheet(session, page.timeline.status ?: session.status, page.timeline.detail ?: session.detail) { info = false }
}

/** 会话信息（照网页）：状态、环境、仓库、分支、PR。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionInfoSheet(session: SessionSummary, status: String, detail: String?, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(horizontal = 24.dp).padding(bottom = 24.dp)) {
            Text(stringResource(R.string.session_info), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            InfoRow(stringResource(R.string.session_status), statusText(status, detail))
            InfoRow(
                stringResource(R.string.environment_label),
                when (val env = session.environmentName) {
                    null -> stringResource(R.string.environment_deleted)
                    "" -> stringResource(R.string.environment_default)
                    else -> env
                },
            )
            if (session.repos.isEmpty()) InfoRow(stringResource(R.string.session_repo), stringResource(R.string.repo_no_repo))
            for (repo in session.repos) {
                InfoRow(
                    stringResource(R.string.session_repo),
                    repo.fullName + if (repo.access == "read") " · " + stringResource(R.string.repo_read_only) else "",
                )
                InfoRow(stringResource(R.string.session_branch), listOf(repo.baseBranch, repo.branch).filter { it.isNotEmpty() }.joinToString(" → "), mono = true)
                repo.pullRequest?.let { pr ->
                    val state = stringResource(
                        when (pr.state) {
                            "draft" -> R.string.pr_draft
                            "merged" -> R.string.pr_merged
                            "closed" -> R.string.pr_closed
                            else -> R.string.pr_open
                        },
                    )
                    InfoRow(stringResource(R.string.session_changes), stringResource(R.string.pr_text, pr.number.toString(), state))
                }
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(88.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, fontFamily = if (mono) FontFamily.Monospace else null, modifier = Modifier.weight(1f))
    }
}

/** 状态和附加说明（照网页的 statusWithDetail）："运行中 · 正在准备沙箱"。 */
@Composable
private fun statusText(status: String, detail: String?): String {
    val label = stringResource(
        when (status) {
            "queued" -> R.string.status_queued
            "running" -> R.string.status_running
            "dormant" -> R.string.status_dormant
            "archived" -> R.string.status_archived
            "failed" -> R.string.status_failed
            else -> R.string.status_waiting
        },
    )
    val extra = when (detail) {
        "preparing_sandbox" -> R.string.status_preparing_sandbox
        "awaiting_input" -> R.string.status_awaiting_input
        "done" -> R.string.status_done
        else -> null
    } ?: return label
    return stringResource(R.string.status_with_detail, label, stringResource(extra))
}

/**
 * 对话：最新的在最下面（列表倒着排，打开时就在底部）。在底部时新内容出来跟着往下；往上翻了就不动，
 * 右下角出现"回到底部"。
 */
@Composable
private fun Conversation(
    entries: List<Entry>,
    listState: LazyListState,
    onRetry: ((String) -> Unit)?,
    onWithdraw: (String, Boolean) -> Unit,
    onSendNow: (String) -> Unit,
    queueActions: Map<String, QueueAction>,
    nameOf: (String) -> String,
) {
    val scope = rememberCoroutineScope()
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        // 只看手动的滚动：停下来时在不在底部
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) follow = !listState.canScrollBackward
        }
    }
    val bottomKey = entries.lastOrNull()?.key
    LaunchedEffect(bottomKey, entries.size) {
        if (follow && entries.isNotEmpty()) listState.scrollToItem(0)
    }
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(30_000)
            value = System.currentTimeMillis()
        }
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.Bottom),
        ) {
            items(entries.asReversed(), key = { it.key }) { entry ->
                Box(Modifier.fillMaxWidth().widthIn(max = 760.dp)) {
                    when (entry) {
                        is Entry.Item -> TimelineEntry(entry.item, entry.live, now, onRetry, nameOf)
                        is Entry.Queued -> QueuedBubble(
                            entry.message,
                            first = entry.first,
                            doing = queueActions[entry.message.id],
                            onWithdraw = { restore -> onWithdraw(entry.message.id, restore) },
                            onSendNow = { onSendNow(entry.message.id) },
                        )
                        is Entry.Pending -> UserBubble(entry.text, entry.at, delivered = false, sending = true, now = now, onRetry = null)
                        is Entry.PlanCard -> PlanCard(entry.plan)
                        is Entry.Working -> WorkingRow(entry)
                        Entry.Tail -> TailRow()
                    }
                }
            }
        }
        val away by remember { androidx.compose.runtime.derivedStateOf { listState.canScrollBackward } }
        if (away) {
            SmallFloatingActionButton(
                onClick = {
                    scope.launch {
                        listState.animateScrollToItem(0)
                        follow = true
                    }
                },
                modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                containerColor = MaterialTheme.colorScheme.surface,
            ) {
                Icon(painterResource(R.drawable.ic_arrow_downward), contentDescription = stringResource(R.string.chat_to_bottom))
            }
        }
    }
}

@Composable
private fun TimelineEntry(item: TimelineItem, live: Boolean, now: Long, onRetry: ((String) -> Unit)?, nameOf: (String) -> String) {
    when (item) {
        is TimelineItem.User -> UserBubble(item.text, item.at, item.delivered, sending = false, now = now, onRetry = onRetry)
        is TimelineItem.Assistant -> AssistantReply(item, live, now)
        is TimelineItem.Tools -> ToolsRow(item.calls)
        is TimelineItem.Changes -> ChangesCard(item.changes)
        is TimelineItem.Notice -> NoticeLine(noticeText(item.notice), item.notice.error)
        is TimelineItem.ModelSwitch -> NoticeLine(
            stringResource(R.string.chat_switched_model, nameOf(item.model), effortName(item.effort)),
            error = false,
        )
    }
}

/** 发出去的消息：气泡在右边，下面一行是 ✓✓（交给 Agent 了）、时间、复制、重试。 */
@Composable
private fun UserBubble(text: String, at: String, delivered: Boolean, sending: Boolean, now: Long, onRetry: ((String) -> Unit)?) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Surface(
            color = MaterialTheme.colorScheme.secondaryContainer,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.widthIn(max = 560.dp).padding(start = 40.dp),
        ) {
            SelectionContainer {
                Text(text, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyLarge)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (sending) {
                val sendingLabel = stringResource(R.string.chat_sending)
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp).semantics { contentDescription = sendingLabel },
                    strokeWidth = 2.dp,
                )
                Spacer(Modifier.width(8.dp))
            } else if (delivered) {
                Icon(
                    painterResource(R.drawable.ic_done_all),
                    contentDescription = stringResource(R.string.chat_delivered),
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(6.dp))
            }
            MetaText(relativeTime(at, now))
            CopyButton(text)
            IconButton(onClick = { onRetry?.invoke(text) }, enabled = onRetry != null) {
                Icon(
                    painterResource(R.drawable.ic_refresh),
                    contentDescription = stringResource(R.string.chat_retry),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/** 排队的消息：像已经发出去一样显示，下面一行是复制、撤回并编辑、删除、立即发送（只有排在最前面的有）。 */
@Composable
private fun QueuedBubble(message: QueuedMessage, first: Boolean, doing: QueueAction?, onWithdraw: (Boolean) -> Unit, onSendNow: () -> Unit) {
    val busy = doing != null
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.widthIn(max = 560.dp).padding(start = 40.dp),
        ) {
            Text(message.text, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyLarge)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!first) MetaText(stringResource(R.string.status_queued))
            CopyButton(message.text)
            ActionIcon(R.drawable.ic_undo, stringResource(R.string.chat_withdraw), enabled = !busy, spinning = doing == QueueAction.Restore) { onWithdraw(true) }
            ActionIcon(R.drawable.ic_close, stringResource(R.string.common_delete), enabled = !busy, spinning = doing == QueueAction.Delete) { onWithdraw(false) }
            if (first) {
                TextButton(onClick = onSendNow, enabled = !busy) {
                    if (doing == QueueAction.SendNow) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Text(stringResource(R.string.chat_send_now))
                    }
                }
            }
        }
    }
}

/** Agent 的回复：按舒服的速度一个个字显示（live 的），显示完了才出现改动卡片和下面那一行（复制、时间）。 */
@Composable
private fun AssistantReply(item: TimelineItem.Assistant, live: Boolean, now: Long) {
    val (shown, done) = rememberPacedText(item.text, live)
    val actions = LocalTimelineActions.current
    val pin = actions.pins[item.key]
    Column(Modifier.fillMaxWidth()) {
        if (pin != null) PinTitle(pin)
        item.thinking?.let { Thinking(it) }
        SelectionContainer {
            Markdown(shown)
        }
        val end = item.turnEnd
        if (done && end != null) {
            end.changes?.let {
                Spacer(Modifier.size(10.dp))
                ChangesCard(it)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                CopyButton(end.reply)
                // 回合最后那条回复可以置顶（照 Claude）：上方展开短标题，顶栏出现置顶列表
                val pinned = pin != null
                IconButton(onClick = { actions.pin(item.key, !pinned) }) {
                    Icon(
                        painterResource(if (pinned) R.drawable.ic_push_pin_filled else R.drawable.ic_push_pin),
                        contentDescription = stringResource(if (pinned) R.string.session_unpin else R.string.session_pin),
                        modifier = Modifier.size(18.dp),
                        tint = if (pinned) MaterialTheme.colorScheme.primary else LocalContentColor.current,
                    )
                }
                MetaText(relativeTime(end.at, now))
            }
        }
    }
}

/** 思考过程：收着，点开看。 */
@Composable
private fun Thinking(text: String) {
    var open by rememberSaveable { mutableStateOf(false) }
    val label = stringResource(R.string.chat_thinking)
    Row(
        Modifier
            .clickable { open = !open }
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Chevron(open)
    }
    if (open) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 12.dp, bottom = 8.dp),
        )
    }
}

@Composable
private fun Chevron(open: Boolean) {
    val angle by animateFloatAsState(if (open) 90f else 0f, label = "chevron")
    Icon(
        painterResource(R.drawable.ic_chevron_right),
        contentDescription = null,
        modifier = Modifier.size(18.dp).rotate(angle),
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * 连续的工具调用：只有一次时是一行"读取 src/app.ts"；两次以上合成一行"读取了 2 个文件，运行了 1 条命令"，点开看每一次。
 * 有工具在跑时写它正在做什么。
 */
@Composable
private fun ToolsRow(calls: List<ToolCallItem>) {
    var open by rememberSaveable { mutableStateOf(false) }
    val only = calls.singleOrNull()
    val running = calls.firstOrNull { it.result == null }
    val failed = calls.lastOrNull()?.result?.isError == true
    val summary = when {
        only != null -> listOf(toolLabel(only.name), toolSummary(only.input)).filter { it.isNotEmpty() }.joinToString(" ")
        running != null -> listOf(toolActive(running.name), toolSummary(running.input)).filter { it.isNotEmpty() }.joinToString(" ")
        else -> summarizeTools(calls)
    }
    val state = when {
        only != null -> callState(only)
        running != null -> CallState.Running
        failed -> CallState.Error
        else -> CallState.Done
    }
    Column(Modifier.fillMaxWidth()) {
        ToolHeader(summary, state, open) { open = !open }
        if (open) {
            if (only != null) {
                ToolBody(only)
            } else {
                Column(Modifier.padding(start = 12.dp)) {
                    for (call in calls) ToolCallRow(call)
                }
            }
        }
    }
}

@Composable
private fun ToolCallRow(call: ToolCallItem) {
    var open by rememberSaveable(call.key) { mutableStateOf(false) }
    val summary = listOf(toolLabel(call.name), toolSummary(call.input)).filter { it.isNotEmpty() }.joinToString(" ")
    ToolHeader(summary, callState(call), open) { open = !open }
    if (open) ToolBody(call)
}

private enum class CallState { Running, Done, Error }

private fun callState(call: ToolCallItem) = when {
    call.result == null -> CallState.Running
    call.result.isError -> CallState.Error
    else -> CallState.Done
}

@Composable
private fun ToolHeader(text: String, state: CallState, open: Boolean, onToggle: () -> Unit) {
    val dot = when (state) {
        CallState.Running -> MaterialTheme.colorScheme.primary
        CallState.Error -> MaterialTheme.colorScheme.error
        CallState.Done -> MaterialTheme.colorScheme.outline
    }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .clickable(onClick = onToggle),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).background(dot, CircleShape))
        Spacer(Modifier.width(10.dp))
        Text(
            text,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Chevron(open)
    }
}

/** 一次工具调用的输入和结果：等宽字体，太宽的横着滚。 */
@Composable
private fun ToolBody(call: ToolCallItem) {
    Column(Modifier.fillMaxWidth().padding(start = 18.dp, bottom = 8.dp)) {
        SectionLabel(stringResource(R.string.chat_tool_input))
        CodeBlock(toolInputText(call.input))
        call.result?.let { result ->
            SectionLabel(stringResource(if (result.isError) R.string.chat_tool_error else R.string.chat_tool_result))
            CodeBlock(result.output.ifEmpty { stringResource(R.string.chat_no_output) })
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 6.dp, bottom = 4.dp),
    )
}

@Composable
private fun CodeBlock(text: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        SelectionContainer {
            Text(
                text,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
                softWrap = false,
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(10.dp),
            )
        }
    }
}

/**
 * 改动卡片（照 Claude）：每个回合结束时单独一张，放在这个回合的最后。改了几个文件时最上面一行"已更改 N 个文件"，
 * 下面列出前三个的文件名和增删行数，最后一行"查看全部"和合计；只改了一个文件时只有一行。
 */
@Composable
private fun ChangesCard(changes: TurnChanges) {
    val actions = LocalTimelineActions.current
    val several = changes.repos.size > 1
    val rows = changes.repos.flatMap { repo -> repo.files.map { repo.fullName to it } }
    val total = rows.size + changes.repos.sumOf { it.omittedFiles }
    val shown = rows.take(SHOWN_FILES)
    val shownPaths = shown.map { it.second.path }
    val label = stringResource(R.string.changes_label)
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(14.dp))
            .semantics { contentDescription = label },
    ) {
        Column {
            if (total > 1) {
                Text(
                    pluralStringResource(R.plurals.changes_changed_files, total, total),
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    style = MaterialTheme.typography.bodyLarge,
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            val single = if (total == 1) rows.firstOrNull()?.second else null
            Column(Modifier.padding(vertical = 4.dp)) {
                for ((repo, file) in shown) {
                    // 点文件名打开改动面板，先展开这个文件
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 40.dp)
                            .clickable { actions.openChanges(file.path) }
                            .padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(painterResource(R.drawable.ic_code), contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.outline)
                        Spacer(Modifier.width(10.dp))
                        val name = (if (several) "${repo.substringAfter('/')}/" else "") + shortPath(file.path, shownPaths)
                        Text(
                            name,
                            modifier = Modifier.weight(1f).semantics { contentDescription = file.from?.let { "$it → ${file.path}" } ?: file.path },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        LineCounts(file)
                        // 只改了一个文件：撤销这个文件这一回合的改动（作为下一条消息交给 Agent 做；Agent 在工作时是灰的）
                        if (single != null) {
                            val undoPrompt = stringResource(R.string.changes_undo_prompt, single.path)
                            TextButton(onClick = { actions.undo?.invoke(undoPrompt) }, enabled = actions.undo != null) {
                                Icon(painterResource(R.drawable.ic_undo), contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                                Text(stringResource(R.string.changes_undo))
                            }
                        }
                    }
                }
                if (total > SHOWN_FILES) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 40.dp)
                            .clickable { actions.openChanges(null) }
                            .padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.changes_view_all), modifier = Modifier.weight(1f))
                        Counts(rows.sumOf { it.second.additions }, rows.sumOf { it.second.deletions })
                    }
                }
            }
            for (repo in changes.repos) {
                when (repo.push) {
                    "read_only" -> CardNote(stringResource(R.string.changes_read_only, repo.fullName), error = false)
                    "failed" -> CardNote(stringResource(R.string.changes_push_failed, repo.fullName), error = true)
                }
            }
        }
    }
}

private const val SHOWN_FILES = 3

/** 卡片上的文件只写文件名；列出来的几个里有同名的，带上上一级目录（照网页的 shortPath）。 */
internal fun shortPath(path: String, others: List<String>): String {
    val parts = path.split('/')
    val base = parts.last()
    val clash = others.any { it != path && it.substringAfterLast('/') == base }
    return if (clash && parts.size > 1) parts.takeLast(2).joinToString("/") else base
}

@Composable
private fun CardNote(text: String, error: Boolean) {
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    Text(
        text,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        style = MaterialTheme.typography.bodySmall,
        color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun LineCounts(file: FileChange) {
    if (file.binary) {
        Text(stringResource(R.string.changes_binary), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
    } else {
        Counts(file.additions, file.deletions)
    }
}

/** 增删的行数：是 0 的那一边不写（照 Claude）。 */
@Composable
private fun Counts(additions: Int, deletions: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (additions > 0) Text("+$additions", color = ADDED, style = MaterialTheme.typography.bodyMedium)
        if (deletions > 0) Text("−$deletions", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
}

private val ADDED = Color(0xFF1F8A4C)

/** 待办清单：只显示最新的一份，回合进行中放在对话最下面。 */
@Composable
private fun PlanCard(plan: Plan) {
    val done = plan.items.count { it.status == "completed" }
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(14.dp)),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row {
                Text(
                    stringResource(if (plan.stale) R.string.chat_plan_stale else R.string.chat_plan),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                Text("$done/${plan.items.size}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            for (todo in plan.items) {
                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    val mark = when (todo.status) {
                        "completed" -> MaterialTheme.colorScheme.primary
                        "in_progress" -> MaterialTheme.colorScheme.tertiary
                        else -> MaterialTheme.colorScheme.outlineVariant
                    }
                    Box(Modifier.size(14.dp).border(1.5.dp, mark, CircleShape), contentAlignment = Alignment.Center) {
                        if (todo.status == "completed") Icon(painterResource(R.drawable.ic_check), contentDescription = null, modifier = Modifier.size(10.dp), tint = mark)
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        todo.content,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (todo.status == "completed") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

/** 对话最后一行在工作时：鲸鱼，写着在做什么，后面是用时和这个回合输出的 token 数（照网页）。 */
@Composable
private fun WorkingRow(entry: Entry.Working) {
    val elapsed = rememberElapsed(entry.since)
    Row(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(R.drawable.whale), contentDescription = null, modifier = Modifier.size(28.dp))
        Spacer(Modifier.width(10.dp))
        Text(
            entry.text + if (entry.ellipsis) "…" else "",
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (elapsed != null) {
            val tokens = entry.progress?.tokens?.takeIf { it > 0 }?.let { " · ↓ ${formatTokens(it)} tokens" }.orEmpty()
            Text(
                "  $elapsed$tokens",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
    }
}

/** 停下来以后的最后一行：鲸鱼和"DeepSeek 是 AI 并且可能会犯错"。 */
@Composable
private fun TailRow() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(R.drawable.whale), contentDescription = null, modifier = Modifier.size(28.dp))
        Spacer(Modifier.width(10.dp))
        Text(stringResource(R.string.chat_ai_notice), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun NoticeLine(text: String, error: Boolean) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth(),
        textAlign = TextAlign.Center,
        style = MaterialTheme.typography.bodySmall,
        color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** 已归档的会话：输入框上面一行说明，可以直接取消归档（之后发消息就唤醒）。 */
@Composable
private fun ArchivedNote(onUnarchive: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.chat_archived_note), modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        TextButton(onClick = onUnarchive) { Text(stringResource(R.string.session_unarchive)) }
    }
}

/**
 * 输入框（照 Claude 的 App）：平时右边是发送键。Agent 在工作时，输入框空着是停止键；有字时是 ↵（插进当前回合，
 * Agent 下一步读到），旁边一个 ⌄，里面是"稍后排队"（等这个回合结束再发）和"停止"。发出去以后输入法不收起。
 */
@Composable
private fun Composer(
    text: String,
    onText: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    busy: Boolean,
    working: Boolean,
    stopping: Boolean,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
) {
    val ready = enabled && !busy && text.isNotBlank()
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = onText,
            placeholder = { Text(placeholder) },
            enabled = enabled,
            maxLines = 6,
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(8.dp))
        if (working && text.isBlank()) {
            val label = stringResource(R.string.composer_stop)
            FilledIconButton(onClick = onStop, enabled = !stopping, modifier = Modifier.size(48.dp)) {
                if (stopping) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Icon(painterResource(R.drawable.ic_stop), contentDescription = label)
                }
            }
        } else {
            val label = stringResource(if (working) R.string.composer_send_now else R.string.chat_send)
            FilledIconButton(
                onClick = { onSend("now") },
                enabled = ready,
                modifier = Modifier.size(48.dp),
                colors = IconButtonDefaults.filledIconButtonColors(),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Icon(painterResource(if (working) R.drawable.ic_keyboard_return else R.drawable.ic_arrow_upward), contentDescription = label)
                }
            }
            if (working) {
                Box {
                    IconButton(onClick = { menu = true }, enabled = ready) {
                        Icon(painterResource(R.drawable.ic_expand_more), contentDescription = stringResource(R.string.composer_more_send))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.composer_later)) },
                            onClick = {
                                menu = false
                                onSend("later")
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.composer_stop)) },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_stop), contentDescription = null) },
                            onClick = {
                                menu = false
                                onStop()
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MetaText(text: String?) {
    if (text == null) return
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp))
}

@Composable
private fun CopyButton(text: String) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    IconButton(onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("", text))) } }) {
        Icon(painterResource(R.drawable.ic_content_copy), contentDescription = stringResource(R.string.common_copy), modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun ActionIcon(icon: Int, label: String, enabled: Boolean, spinning: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled) {
        if (spinning) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        } else {
            Icon(painterResource(icon), contentDescription = label, modifier = Modifier.size(18.dp))
        }
    }
}

/**
 * 回复一个个字显示出来（规则在 PacedText.kt）：[live] 为假（打开会话时已有的历史）或系统关了动画时直接显示全文。
 * 显示到哪了按列表里这一行记着，翻出去再翻回来接着显示。
 */
@Composable
private fun rememberPacedText(text: String, live: Boolean): Pair<String, Boolean> {
    val context = LocalContext.current
    val animate = remember { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f }
    var count by rememberSaveable { mutableIntStateOf(if (live && animate) 0 else Int.MAX_VALUE) }
    val blocked = remember(text) { cutMap(text) }
    val shown = minOf(count, text.length)
    LaunchedEffect(shown, text) {
        if (shown >= text.length) return@LaunchedEffect
        if (!animate) {
            count = text.length
            return@LaunchedEffect
        }
        delay(PACED_TICK_MS)
        count = nextCut(blocked, shown, shown + pacedStep(text.length - shown))
    }
    return text.substring(0, shown) to (shown >= text.length)
}

/** 每秒刷新一次的"已经过了多久"。 */
@Composable
private fun rememberElapsed(since: String?): String? {
    val start = remember(since) { since?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } } ?: return null
    val now by produceState(System.currentTimeMillis(), start) {
        while (true) {
            value = System.currentTimeMillis()
            delay(1000)
        }
    }
    val seconds = maxOf(0L, (now - start) / 1000)
    return when {
        seconds < 60 -> stringResource(R.string.time_elapsed_seconds, seconds.toString())
        seconds < 3600 -> stringResource(R.string.time_elapsed_minutes, (seconds / 60).toString(), (seconds % 60).toString())
        else -> stringResource(R.string.time_elapsed_hours, (seconds / 3600).toString(), (seconds % 3600 / 60).toString())
    }
}

/** token 数的写法：1234 → "1.2k"（照网页）。 */
internal fun formatTokens(tokens: Int): String = if (tokens < 1000) tokens.toString() else "%.1fk".format(java.util.Locale.ROOT, tokens / 1000.0)

/** "刚刚""3 分钟前"这类，跟着系统语言。 */
@Composable
private fun relativeTime(iso: String, now: Long): String? {
    val time = remember(iso) { runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull() } ?: return null
    if (now - time < 60_000) return stringResource(R.string.time_just_now)
    return DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString()
}

private fun firstLine(text: String): String = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()

/** 认得的工具：名字和正在做时的说法（照网页的 timeline.ts）。 */
private val TOOLS = mapOf(
    "Read" to (R.string.tool_read to R.string.tool_read_active),
    "Write" to (R.string.tool_write to R.string.tool_write_active),
    "Edit" to (R.string.tool_edit to R.string.tool_edit_active),
    "MultiEdit" to (R.string.tool_edit to R.string.tool_edit_active),
    "Bash" to (R.string.tool_bash to R.string.tool_bash_active),
    "Grep" to (R.string.tool_grep to R.string.tool_grep_active),
    "Glob" to (R.string.tool_glob to R.string.tool_glob_active),
    "LS" to (R.string.tool_ls to R.string.tool_ls_active),
    "WebFetch" to (R.string.tool_web_fetch to R.string.tool_web_fetch_active),
    "WebSearch" to (R.string.tool_web_search to R.string.tool_web_search_active),
    "TodoWrite" to (R.string.tool_todo to R.string.tool_todo_active),
    "Task" to (R.string.tool_task to R.string.tool_task_active),
)

@Composable
private fun toolLabel(name: String): String = TOOLS[name]?.let { stringResource(it.first) } ?: name

@Composable
private fun toolActive(name: String): String = TOOLS[name]?.let { stringResource(it.second) } ?: stringResource(R.string.tool_other_active, name)

/** 一组工具调用怎么说：按工具归类计数，每一类一个整句，按语言连起来（照网页的 summarizeTools）。 */
private val KINDS = listOf(
    listOf("Read") to R.plurals.tools_read,
    listOf("Edit", "MultiEdit", "Write") to R.plurals.tools_edit,
    listOf("Bash") to R.plurals.tools_bash,
    listOf("Grep", "Glob", "LS", "WebSearch") to R.plurals.tools_search,
    listOf("WebFetch") to R.plurals.tools_fetch,
)

@Composable
private fun summarizeTools(calls: List<ToolCallItem>): String {
    val counts = IntArray(KINDS.size)
    var other = 0
    for (call in calls) {
        val index = KINDS.indexOfFirst { call.name in it.first }
        if (index < 0) other++ else counts[index]++
    }
    val parts = buildList {
        KINDS.forEachIndexed { i, (_, id) -> if (counts[i] > 0) add(pluralStringResource(id, counts[i], counts[i])) }
        if (other > 0) add(pluralStringResource(R.plurals.tools_other, other, other))
    }
    return joinClauses(parts)
}

/** 几个分句连成一句：中文用逗号；英文 "a, b, and c"，开头大写（照网页的 joinClauses）。 */
@Composable
private fun joinClauses(parts: List<String>): String {
    val locale = LocalConfiguration.current.locales[0]
    if (locale.language == "zh") return parts.joinToString("，")
    val text = android.icu.text.ListFormatter.getInstance(locale).format(parts)
    return text.replaceFirstChar { it.uppercaseChar() }
}

@Composable
private fun noticeText(notice: TimelineNotice): String = when (notice) {
    TimelineNotice.PushFollowUp -> stringResource(R.string.chat_push_follow_up)
    is TimelineNotice.PushGaveUp -> {
        val locale = LocalConfiguration.current.locales[0]
        val repos = if (locale.language == "zh") notice.repos.joinToString("、") else android.icu.text.ListFormatter.getInstance(locale).format(notice.repos)
        pluralStringResource(R.plurals.chat_push_gave_up, MAX_PUSH_FOLLOW_UPS, MAX_PUSH_FOLLOW_UPS, repos)
    }
    is TimelineNotice.TurnStopped -> notice.cause?.let { stringResource(R.string.chat_turn_stopped_with, agentErrorText(it)) } ?: stringResource(R.string.chat_turn_stopped)
    is TimelineNotice.TurnFailed -> notice.cause?.let { stringResource(R.string.chat_turn_failed_with, agentErrorText(it)) } ?: stringResource(R.string.chat_turn_failed)
    is TimelineNotice.SessionFailed -> notice.cause?.let { stringResource(R.string.chat_session_failed_with, agentErrorText(it)) } ?: stringResource(R.string.chat_session_failed)
}

/** 推送失败时同一条消息最多自动跟进几次（协议包的 MAX_PUSH_FOLLOW_UPS）。 */
private const val MAX_PUSH_FOLLOW_UPS = 2

/** Agent 的报错给人看的样子：一句说明，后面括号里是状态码和参考号（ADR 0007，照网页的 errorText）。 */
@Composable
private fun agentErrorText(error: SafeError): String {
    val text = stringResource(
        when (error.code) {
            "model_unavailable" -> R.string.agent_error_model_unavailable
            "model_rate_limited" -> R.string.agent_error_model_rate_limited
            "model_rejected" -> R.string.agent_error_model_rejected
            "context_too_long" -> R.string.agent_error_context_too_long
            "timeout" -> R.string.agent_error_timeout
            "sandbox_unavailable" -> R.string.agent_error_sandbox_unavailable
            "repo_clone_failed" -> R.string.agent_error_repo_clone_failed
            else -> R.string.agent_error_internal
        },
    )
    val extra = listOfNotNull(error.status?.toString(), error.ref?.let { stringResource(R.string.agent_error_ref, it) })
    return if (extra.isEmpty()) text else stringResource(R.string.agent_error_with_detail, text, extra.joinToString(" · "))
}

/** 时间线上的几样操作：打开改动面板、撤销一个文件的改动、置顶。 */
private data class TimelineActions(
    val openChanges: (String?) -> Unit = {},
    /** 发一条消息给 Agent（撤销一个文件的改动）；Agent 在工作时为 null。 */
    val undo: ((String) -> Unit)? = null,
    val pins: Map<Int, MessagePin> = emptyMap(),
    val pin: (Int, Boolean) -> Unit = { _, _ -> },
)

private val LocalTimelineActions = compositionLocalOf { TimelineActions() }

/** 置顶的回复上方的短标题（照网页）：还在生成时是一条占位的闪烁条；取不出标题时写"置顶的消息"。 */
@Composable
private fun PinTitle(pin: MessagePin) {
    Row(Modifier.padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(R.drawable.ic_push_pin_filled), contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(6.dp))
        val title = pin.title
        if (title == null) {
            val loading = stringResource(R.string.chat_generating_title)
            val alpha by rememberInfiniteTransition(label = "pin-title").animateFloat(
                initialValue = 0.35f,
                targetValue = 0.8f,
                animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
                label = "pin-title-alpha",
            )
            Box(
                Modifier
                    .size(width = 160.dp, height = 14.dp)
                    .graphicsLayer { this.alpha = alpha }
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(7.dp))
                    .semantics { contentDescription = loading },
            )
        } else {
            Text(title.ifEmpty { stringResource(R.string.chat_pin_fallback) }, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** 顶栏的置顶列表（照网页的 PinNav）："会话开头"和每条置顶的短标题，点哪个滚到哪条。 */
@Composable
private fun PinNav(pins: List<MessagePin>, onGo: (Int?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(painterResource(R.drawable.ic_toc), contentDescription = pluralStringResource(R.plurals.chat_pinned_messages, pins.size, pins.size))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_session_start)) },
                onClick = {
                    open = false
                    onGo(null)
                },
            )
            for (pin in pins) {
                DropdownMenuItem(
                    text = {
                        Text(
                            when (val title = pin.title) {
                                null -> stringResource(R.string.chat_generating_title)
                                "" -> stringResource(R.string.chat_pin_fallback)
                                else -> title
                            },
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    leadingIcon = { Icon(painterResource(R.drawable.ic_push_pin), contentDescription = null, modifier = Modifier.size(18.dp)) },
                    onClick = {
                        open = false
                        onGo(pin.seq)
                    },
                )
            }
        }
    }
}

/**
 * 滚到第 [index] 行，让这一行的顶边对齐屏幕上方（列表是倒着排的：先滚到这一行，它在最下面，再往上挪出它多出来的高度）。
 */
private suspend fun LazyListState.revealTop(index: Int) {
    scrollToItem(index)
    val info = layoutInfo.visibleItemsInfo.firstOrNull { it.index == index } ?: return
    val viewport = layoutInfo.viewportEndOffset - layoutInfo.viewportStartOffset
    scrollBy((info.offset + info.size - viewport).toFloat())
}

/**
 * 改动面板（照网页的 ChangesPanel）：会话分支对比基础分支的改动，占满屏幕。文件少（10 个以内）时都展开，
 * 从卡片上点文件名打开时先展开、滚到那个文件。逐行的 diff：旧行号、新行号、增删的颜色。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChangesPanel(ui: ChangesPanelUi, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                val files = ui.repos?.flatMap { it.files }.orEmpty()
                TopAppBar(
                    title = {
                        Column {
                            Text(stringResource(R.string.changes_title), modifier = Modifier.semantics { heading() })
                            if (files.isNotEmpty()) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(pluralStringResource(R.plurals.changes_file_count, files.size, files.size), style = MaterialTheme.typography.bodySmall)
                                    Counts(files.sumOf { it.additions }, files.sumOf { it.deletions })
                                }
                            }
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onClose) {
                            Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.common_close))
                        }
                    },
                )
                when {
                    ui.failure != null -> Box(Modifier.padding(16.dp)) { Notice(failureText(ui.failure, LocalResources.current.errorTexts()), error = true) }
                    ui.repos == null -> Text(stringResource(R.string.common_loading), modifier = Modifier.padding(16.dp))
                    files.isEmpty() -> Text(stringResource(R.string.changes_empty), modifier = Modifier.padding(16.dp))
                    else -> DiffList(ui.repos, ui.focus)
                }
            }
        }
    }
}

@Composable
private fun DiffList(repos: List<RepoDiff>, focus: String?) {
    val opened = remember(repos) {
        mutableStateMapOf<String, Boolean>().apply {
            for (repo in repos) for (file in repo.files) put("${repo.fullName}:${file.path}", file.path == focus || repo.files.size <= 10)
        }
    }
    val listState = rememberLazyListState()
    // 从卡片上点文件名打开的：滚到那个文件
    LaunchedEffect(repos, focus) {
        if (focus == null) return@LaunchedEffect
        var index = 0
        for (repo in repos.filter { it.files.isNotEmpty() }) {
            index++ // 仓库的标题
            for (file in repo.files) {
                if (file.path == focus) {
                    listState.scrollToItem(index)
                    return@LaunchedEffect
                }
                index++
                if (opened["${repo.fullName}:${file.path}"] == true) index += diffBodySize(file)
            }
            if (repo.truncated) index++
        }
    }
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
        for (repo in repos.filter { it.files.isNotEmpty() }) {
            item(key = "repo:${repo.fullName}") {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(repo.fullName, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f, fill = false))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.changes_compare_with, repo.baseBranch), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            for (file in repo.files) {
                val id = "${repo.fullName}:${file.path}"
                val open = opened[id] == true
                item(key = "file:$id") {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 44.dp)
                            .background(MaterialTheme.colorScheme.surface)
                            .clickable { opened[id] = !open }
                            .padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Chevron(open)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            file.path,
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f).semantics { file.from?.let { contentDescription = "$it → ${file.path}" } },
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (file.binary) {
                            Text(stringResource(R.string.changes_binary), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                        } else {
                            Counts(file.additions, file.deletions)
                        }
                    }
                }
                if (open) diffBody(this, id, file)
            }
            if (repo.truncated) {
                item(key = "truncated:${repo.fullName}") {
                    Text(stringResource(R.string.changes_truncated), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
                }
            }
        }
    }
}

/** 展开的文件占几行（滚到某个文件时算位置用），和 [diffBody] 放的一样多。 */
private fun diffBodySize(file: DiffFile): Int {
    val notes = if (file.from != null) 1 else 0
    if (file.binary || file.tooLarge || file.patch == null) return notes + 1
    val lines = patchLines(file.patch).size
    return notes + if (lines == 0) 1 else lines
}

private fun diffBody(scope: LazyListScope, id: String, file: DiffFile) {
    with(scope) {
        if (file.from != null) item(key = "renamed:$id") { DiffNote(stringResource(R.string.changes_renamed_from, file.from)) }
        val note = when {
            file.binary -> R.string.changes_binary_file
            file.tooLarge -> R.string.changes_too_large
            file.patch == null -> R.string.changes_no_patch
            else -> null
        }
        if (note != null) {
            item(key = "note:$id") { DiffNote(stringResource(note)) }
            return
        }
        val lines = patchLines(file.patch.orEmpty())
        if (lines.isEmpty()) {
            item(key = "note:$id") { DiffNote(stringResource(R.string.changes_mode_only)) }
            return
        }
        items(lines.size, key = { "line:$id:$it" }) { i -> DiffLine(lines[i]) }
    }
}

@Composable
private fun DiffNote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

/** diff 的一行：旧行号、新行号、正文（太长的折行）。 */
@Composable
private fun DiffLine(line: PatchLine) {
    val dark = LocalDarkTheme.current
    val background = when (line.kind) {
        PatchLine.Kind.Add -> if (dark) Color(0x332EA043) else Color(0xFFE6FFEC)
        PatchLine.Kind.Del -> if (dark) Color(0x33F85149) else Color(0xFFFFEBE9)
        PatchLine.Kind.Hunk -> MaterialTheme.colorScheme.surfaceVariant
        else -> Color.Transparent
    }
    val style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().background(background).padding(vertical = 1.dp)) {
        Text(line.old?.toString().orEmpty(), style = style, color = muted, textAlign = TextAlign.End, modifier = Modifier.width(40.dp))
        Text(line.new?.toString().orEmpty(), style = style, color = muted, textAlign = TextAlign.End, modifier = Modifier.width(40.dp))
        Spacer(Modifier.width(8.dp))
        val text = when (line.kind) {
            PatchLine.Kind.Add -> "+${line.text}"
            PatchLine.Kind.Del -> "−${line.text}"
            PatchLine.Kind.NoNewline -> stringResource(R.string.changes_no_newline)
            PatchLine.Kind.Hunk -> line.text
            PatchLine.Kind.Ctx -> " ${line.text}"
        }
        Text(text, style = style, color = if (line.kind == PatchLine.Kind.Hunk || line.kind == PatchLine.Kind.NoNewline) muted else Color.Unspecified, modifier = Modifier.weight(1f).padding(end = 8.dp))
    }
}
