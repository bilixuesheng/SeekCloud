package cn.seekcloud.app.ui

import android.content.Intent
import android.text.format.DateUtils
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.seekcloud.app.R
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.sessions.SessionGroup
import cn.seekcloud.app.sessions.SessionListState
import cn.seekcloud.app.sessions.SessionListViewModel
import cn.seekcloud.app.sessions.SessionRepo
import cn.seekcloud.app.sessions.SessionSummary
import cn.seekcloud.app.sessions.StatusMark
import cn.seekcloud.app.sessions.sections
import cn.seekcloud.app.sessions.statusMark
import java.time.Instant

/** 会话列表（#124）：登录以后的第一页。App 在前台时连着主站的事件流。 */
@Composable
fun SessionListRoute(
    server: SavedServer,
    viewModel: SessionListViewModel,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
) {
    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val connected by viewModel.connected.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val context = LocalContext.current
    SessionListScreen(
        server = server,
        state = state,
        connected = connected,
        refreshing = refreshing,
        onRefresh = viewModel::refresh,
        // 会话页（#182）做好以前，先在浏览器里打开网页上的会话页
        onOpen = { context.startActivity(Intent(Intent.ACTION_VIEW, "${server.origin}/s/${it.shortId}".toUri())) },
        onSwitchServer = onSwitchServer,
        onSignOut = onSignOut,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    server: SavedServer,
    state: SessionListState,
    connected: Boolean,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onOpen: (SessionSummary) -> Unit,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var archivedOpen by rememberSaveable { mutableStateOf(false) }
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    val host = server.address?.host ?: server.origin

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.app_name), maxLines = 1)
                        Text(
                            host,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = {
                        searching = !searching
                        if (!searching) query = ""
                    }) {
                        Icon(
                            painterResource(if (searching) R.drawable.ic_close else R.drawable.ic_search),
                            contentDescription = stringResource(
                                if (searching) R.string.sessions_clear_search else R.string.sidebar_search,
                            ),
                        )
                    }
                    OverflowMenu(onSwitchServer = onSwitchServer, onSignOut = { confirmSignOut = true })
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            AnimatedVisibility(visible = !connected) {
                Text(
                    stringResource(R.string.sessions_offline),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(vertical = 6.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            AnimatedVisibility(visible = searching) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(stringResource(R.string.sidebar_search)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                    else -> SessionSections(state, query, archivedOpen, { archivedOpen = !archivedOpen }, onOpen)
                }
            }
        }
    }

    if (confirmSignOut) {
        ConfirmDialog(
            title = stringResource(R.string.sign_out_title),
            body = stringResource(R.string.sign_out_body, host),
            confirm = stringResource(R.string.sign_out),
            onConfirm = {
                confirmSignOut = false
                onSignOut()
            },
            onDismiss = { confirmSignOut = false },
        )
    }
}

/** 右上角的"更多选项"。设置（#181）做好以前，换服务器和退出登录先放在这里。 */
@Composable
private fun OverflowMenu(onSwitchServer: () -> Unit, onSignOut: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(painterResource(R.drawable.ic_more_vert), contentDescription = stringResource(R.string.sessions_more))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.switch_server)) }, onClick = {
                open = false
                onSwitchServer()
            })
            DropdownMenuItem(text = { Text(stringResource(R.string.sign_out)) }, onClick = {
                open = false
                onSignOut()
            })
        }
    }
}

@Composable
private fun SessionSections(
    state: SessionListState,
    query: String,
    archivedOpen: Boolean,
    onToggleArchived: () -> Unit,
    onOpen: (SessionSummary) -> Unit,
) {
    val s = sections(state.sessions, state.groups, query)
    val empty = s.pinned.isEmpty() && s.recent.isEmpty() && s.archived.isEmpty() && s.groups.all { it.second.isEmpty() }
    if (empty) {
        // 下拉刷新要有能滚动的内容才拉得动
        LazyColumn(Modifier.fillMaxSize()) {
            item { EmptyList(if (query.isBlank()) R.string.session_list_empty else R.string.session_list_no_match) }
        }
        return
    }
    val now = remember(state) { System.currentTimeMillis() }
    val pinned = stringResource(R.string.sidebar_pinned)
    val recent = stringResource(R.string.sidebar_recent)
    val archived = stringResource(R.string.sidebar_archived)
    LazyColumn(Modifier.fillMaxSize()) {
        section("pinned", pinned, s.pinned, now, onOpen)
        for ((group, sessions) in s.groups) section("group:${group.id}", group.name, sessions, now, onOpen, showEmpty = true)
        section("recent", if (query.isBlank()) recent else null, s.recent, now, onOpen)
        if (s.archived.isNotEmpty()) {
            item(key = "archived") {
                SectionHeader(
                    archived,
                    expanded = archivedOpen,
                    onToggle = onToggleArchived,
                )
            }
            if (archivedOpen) items(s.archived, key = { "archived:${it.shortId}" }) { SessionRow(it, now, onOpen) }
        }
    }
}

private fun LazyListScope.section(
    key: String,
    title: String?,
    sessions: List<SessionSummary>,
    now: Long,
    onOpen: (SessionSummary) -> Unit,
    showEmpty: Boolean = false,
) {
    if (sessions.isEmpty() && !showEmpty) return
    if (title != null) item(key = "header:$key") { SectionHeader(title) }
    if (sessions.isEmpty()) {
        item(key = "empty:$key") {
            Text(
                stringResource(R.string.sidebar_group_empty),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
    }
    items(sessions, key = { "$key:${it.shortId}" }) { SessionRow(it, now, onOpen) }
}

@Composable
private fun SectionHeader(title: String, expanded: Boolean? = null, onToggle: (() -> Unit)? = null) {
    val toggle = stringResource(if (expanded == true) R.string.sessions_collapse else R.string.sessions_expand)
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onToggle != null) Modifier.clickable(onClick = onToggle) else Modifier)
            .padding(start = 20.dp, end = 12.dp, top = 16.dp, bottom = 4.dp)
            .semantics {
                heading()
                if (expanded != null) stateDescription = toggle
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (expanded != null) {
            Icon(
                painterResource(if (expanded) R.drawable.ic_expand_less else R.drawable.ic_expand_more),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** 一个会话一行：标题（普通文字，不当 Markdown）、主仓库、多久以前，右边是状态标记。 */
@Composable
private fun SessionRow(session: SessionSummary, now: Long, onOpen: (SessionSummary) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpen(session) }
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                session.title,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val meta = listOfNotNull(session.repos.firstOrNull()?.fullName, relativeTime(session.updatedAt, now))
            if (meta.isNotEmpty()) {
                Text(
                    meta.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        StatusMarkView(statusMark(session))
    }
}

/** "3 分钟前"这类，跟着系统语言（安卓自带的）。读不懂的时间不写。 */
private fun relativeTime(iso: String, now: Long): String? = runCatching {
    val time = Instant.parse(iso).toEpochMilli()
    DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE)
        .toString()
}.getOrNull()

/** 状态标记（照网页）：运行中是一明一暗呼吸的灰点，失败是警告三角，等你输入是强调色的圆圈里一个点，有新内容是蓝点。 */
@Composable
private fun StatusMarkView(mark: StatusMark?) {
    if (mark == null) return
    val label = stringResource(
        when (mark) {
            StatusMark.Failed -> R.string.status_failed
            StatusMark.Running -> R.string.status_running
            StatusMark.Awaiting -> R.string.status_awaiting_input
            StatusMark.Unread -> R.string.status_unread
        },
    )
    val modifier = Modifier.size(20.dp).semantics { contentDescription = label }
    val primary = MaterialTheme.colorScheme.primary
    when (mark) {
        StatusMark.Failed -> Icon(
            painterResource(R.drawable.ic_warning),
            contentDescription = label,
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(20.dp),
        )
        StatusMark.Running -> {
            val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
                initialValue = 0.35f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(650), RepeatMode.Reverse),
                label = "alpha",
            )
            val gray = MaterialTheme.colorScheme.onSurfaceVariant
            Canvas(modifier) { drawCircle(gray.copy(alpha = pulse), radius = 4.dp.toPx()) }
        }
        StatusMark.Awaiting -> Canvas(modifier) {
            drawCircle(primary, radius = 6.dp.toPx(), style = Stroke(width = 1.5.dp.toPx()))
            drawCircle(primary, radius = 2.5.dp.toPx())
        }
        StatusMark.Unread -> Canvas(modifier) { drawCircle(primary, radius = 4.dp.toPx()) }
    }
}

@Composable
private fun EmptyList(text: Int) {
    Column(
        Modifier.fillMaxWidth().padding(top = 96.dp, start = 32.dp, end = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Image(painterResource(R.drawable.whale), contentDescription = null, modifier = Modifier.size(72.dp))
        Spacer(Modifier.height(16.dp))
        Text(
            stringResource(text),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 320.dp),
        )
    }
}

@Preview
@Composable
private fun SessionListPreview() {
    fun s(id: String, title: String, status: String, pinned: Boolean = false, detail: String? = null, unread: Boolean = false) =
        SessionSummary(
            shortId = id, title = title, status = status, detail = detail, repos = listOf(SessionRepo("acme/web")),
            pinnedAt = if (pinned) "2026-11-24T00:00:00Z" else null, unread = unread,
            createdAt = "2026-11-24T00:00:00Z", updatedAt = "2026-11-24T00:00:00Z",
        )
    val state = SessionListState(
        sessions = listOf(
            s("a", "修复登录页的样式", "running", pinned = true),
            s("b", "Add dark mode", "waiting", detail = "awaiting_input"),
            s("c", "升级依赖", "failed"),
            s("d", "写 README", "dormant", unread = true),
        ),
        groups = listOf(SessionGroup("g", "Backend", 1.0)),
        loaded = true,
    )
    SeekCloudTheme {
        SessionListScreen(SavedServer("p", "https://seekcloud.example.com"), state, false, false, {}, {}, {}, {})
    }
}
