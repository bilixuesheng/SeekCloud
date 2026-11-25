package cn.seekcloud.app.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.Dp
import cn.seekcloud.app.settings.AppPreferences
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material3.VerticalDivider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import cn.seekcloud.app.sessions.awaitingInput
import android.os.Build
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import kotlinx.coroutines.launch
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
import androidx.compose.material3.ExtendedFloatingActionButton
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
import androidx.compose.runtime.LaunchedEffect
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
import cn.seekcloud.app.sessions.NewSessionViewModel
import cn.seekcloud.app.sessions.SessionGroup
import cn.seekcloud.app.sessions.SessionListState
import cn.seekcloud.app.sessions.SessionListViewModel
import cn.seekcloud.app.sessions.SessionViewModel
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
    nickname: String?,
    viewModel: SessionListViewModel,
    newSession: @Composable () -> NewSessionViewModel,
    sessionPage: @Composable (shortId: String) -> SessionViewModel,
    preferences: AppPreferences,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
) {
    // 底栏的三项：会话、新会话、设置（#178）；会话页盖在上面，按返回回到列表（转屏不丢）
    var tab by rememberSaveable { mutableIntStateOf(TAB_SESSIONS) }
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    LifecycleStartEffect(viewModel) {
        viewModel.start()
        onStopOrDispose { viewModel.stop() }
    }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val connected by viewModel.connected.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val menu by viewModel.menu.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val copied = stringResource(R.string.session_link_copied)
    val openSession = { s: SessionSummary ->
        openId = s.shortId
        if (tab == TAB_NEW) tab = TAB_SESSIONS
    }
    val waiting = awaitingInput(state.sessions)
    // 宽屏（平板、大屏手机横过来、折叠屏展开）：左边会话列表，右边新会话页（照网页宽屏的布局）
    val wide = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.width.toDp() } >= 840.dp
    // 内容能滚到底栏下面，最后一行不被挡住
    val barInset = TAB_BAR_HEIGHT + TAB_BAR_MARGIN * 2
    val newSessionPage = @Composable { onBack: (() -> Unit)? ->
        NewSessionRoute(
            origin = server.origin,
            viewModel = newSession(),
            nickname = nickname,
            waiting = waiting,
            onOpen = openSession,
            // 发起以后直接进会话页
            onCreated = openSession,
            onBack = onBack,
            bottomInset = barInset,
        )
    }
    val sessionPageFor = @Composable { shortId: String ->
        SessionRoute(
            listed = state.sessions.firstOrNull { it.shortId == shortId },
            viewModel = sessionPage(shortId),
            onBack = { openId = null },
            onMenu = { viewModel.openMenu(shortId) },
        )
    }
    val open = openId
    // 开着的会话在列表里出现过、又不在了（在菜单里或者别处删掉了）：回到列表
    var seen by remember(open) { mutableStateOf(false) }
    val present = open != null && state.sessions.any { it.shortId == open }
    LaunchedEffect(open, present) {
        if (present) seen = true else if (seen) openId = null
    }
    val list = @Composable { modifier: Modifier ->
        Box(modifier) {
            SessionListScreen(
                server = server,
                state = state,
                connected = connected,
                refreshing = refreshing,
                onRefresh = viewModel::refresh,
                onOpen = openSession,
                onNewSession = { tab = TAB_NEW },
                onMenu = { viewModel.openMenu(it.shortId) },
                onSwitchServer = onSwitchServer,
                onSignOut = onSignOut,
                snackbar = snackbar,
                // 底栏里有"新会话"，不要右下角的按钮
                showNewSession = false,
                bottomInset = barInset,
            )
        }
    }
    // 液态玻璃的底栏（#178）：下面的内容画进 backdrop，底栏从它取像素做折射和模糊
    val glass by preferences.glass.collectAsStateWithLifecycle()
    val powerSave = rememberPowerSave()
    val canLiquid = Build.VERSION.SDK_INT >= 33 && !powerSave
    val slow = rememberSlowRendering(enabled = canLiquid)
    val render = chooseGlassRender(Build.VERSION.SDK_INT, powerSave, slow, preferences.forcedRender)
    val backdrop = rememberLayerBackdrop()
    // 往下滚时收起，往上滚时出现（照 Claude 的 App）；键盘弹出、菜单打开时也收起
    var scrolledAway by remember { mutableStateOf(false) }
    val hideOnScroll = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (available.y < -8f) scrolledAway = true
                if (available.y > 8f) scrolledAway = false
                return Offset.Zero
            }
        }
    }
    val imeOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val barShown = !scrolledAway && !imeOpen && menu == null
    LaunchedEffect(tab) { scrolledAway = false }
    val animationsOff = rememberAnimationsOff()
    val barOffset by animateFloatAsState(
        if (barShown) 0f else 1f,
        if (animationsOff) tween(0) else tween(220),
        label = "tab-bar-offset",
    )
    val tabs = listOf(
        TabItem(stringResource(R.string.tabs_sessions), R.drawable.ic_chat_bubble, R.drawable.ic_chat_bubble_filled),
        TabItem(stringResource(R.string.sidebar_new_session), R.drawable.ic_edit_square, R.drawable.ic_edit_square_filled),
        TabItem(stringResource(R.string.tabs_settings), R.drawable.ic_settings, R.drawable.ic_settings_filled),
    )
    val settingsPage = @Composable {
        AppSettingsScreen(
            server = server,
            glass = glass,
            render = render,
            onGlass = preferences::setGlass,
            onSwitchServer = onSwitchServer,
            onSignOut = onSignOut,
            bottomInset = barInset,
        )
    }
    val bar = @Composable { modifier: Modifier ->
        GlassTabBar(
            backdrop = backdrop,
            tabs = tabs,
            // 宽屏时右边开着会话算在"会话"
            selected = tab,
            onSelect = { index ->
                tab = index
                if (index == TAB_NEW) openId = null
            },
            style = glass,
            render = render,
            modifier = modifier
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = TAB_BAR_MARGIN)
                .graphicsLayer {
                    translationY = barOffset * (size.height + TAB_BAR_MARGIN.toPx() * 2 + 48.dp.toPx())
                    alpha = 1f - barOffset
                },
        )
    }
    if (!wide && open != null) {
        // 进会话页时底栏收起
        sessionPageFor(open)
    } else if (wide) {
        Row(Modifier.fillMaxSize()) {
            // 底栏放在列表那一栏的底部（#178 的边界情况）
            Box(Modifier.width(380.dp).fillMaxHeight().nestedScroll(hideOnScroll)) {
                Box(Modifier.fillMaxSize().layerBackdrop(backdrop)) { list(Modifier.fillMaxSize()) }
                bar(Modifier.align(Alignment.BottomCenter))
            }
            VerticalDivider()
            // 右边：设置、开着的会话，都没有时是新会话页
            Box(Modifier.weight(1f).fillMaxHeight()) {
                when {
                    tab == TAB_SETTINGS -> settingsPage()
                    open != null -> sessionPageFor(open)
                    else -> newSessionPage(null)
                }
            }
        }
    } else {
        if (tab != TAB_SESSIONS) BackHandler { tab = TAB_SESSIONS }
        Box(Modifier.fillMaxSize().nestedScroll(hideOnScroll)) {
            Box(Modifier.fillMaxSize().layerBackdrop(backdrop)) {
                when (tab) {
                    TAB_NEW -> newSessionPage(null)
                    TAB_SETTINGS -> settingsPage()
                    else -> list(Modifier.fillMaxSize())
                }
            }
            bar(Modifier.align(Alignment.BottomCenter))
        }
    }
    val sheet = menu
    val session = sheet?.let { m -> state.sessions.firstOrNull { it.shortId == m.shortId } }
    if (sheet != null && session != null) {
        SessionMenuSheet(
            origin = server.origin,
            session = session,
            groups = state.groups,
            menu = sheet,
            onPage = viewModel::showPage,
            onPerform = viewModel::perform,
            onCopied = {
                viewModel.closeMenu()
                // 安卓 13 以上系统自己会提示复制了什么，不再重复
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) scope.launch { snackbar.showSnackbar(copied) }
            },
            onDismiss = viewModel::closeMenu,
        )
    }
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
    onMenu: (SessionSummary) -> Unit,
    onNewSession: () -> Unit,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
    snackbar: SnackbarHostState = remember { SnackbarHostState() },
    /** 宽屏时新会话页一直在右边，不要右下角的按钮。 */
    showNewSession: Boolean = true,
    /** 列表下面留出的空白（底栏浮在上面）。 */
    bottomInset: Dp = 0.dp,
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
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = {
            if (showNewSession) {
                val label = stringResource(R.string.sidebar_new_session)
                ExtendedFloatingActionButton(
                    onClick = onNewSession,
                    icon = { Icon(painterResource(R.drawable.ic_add), contentDescription = null) },
                    text = { Text(label) },
                    // 扩展的浮动按钮把文字那一块的语义清掉了（Material 3 的做法）：读屏要靠这里的说明
                    modifier = Modifier.semantics { contentDescription = label },
                )
            }
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
                    else -> SessionSections(state, query, archivedOpen, { archivedOpen = !archivedOpen }, onOpen, onMenu, bottomInset)
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
    onMenu: (SessionSummary) -> Unit,
    bottomInset: Dp = 0.dp,
) {
    val padding = PaddingValues(bottom = bottomInset)
    val row: @Composable (SessionSummary) -> Unit = { SessionRow(it, now(state), onOpen, onMenu) }
    val s = sections(state.sessions, state.groups, query)
    val empty = s.pinned.isEmpty() && s.recent.isEmpty() && s.archived.isEmpty() && s.groups.all { it.second.isEmpty() }
    if (empty) {
        // 下拉刷新要有能滚动的内容才拉得动
        LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
            item { EmptyList(if (query.isBlank()) R.string.session_list_empty else R.string.session_list_no_match) }
        }
        return
    }
    val pinned = stringResource(R.string.sidebar_pinned)
    val recent = stringResource(R.string.sidebar_recent)
    val archived = stringResource(R.string.sidebar_archived)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
        section("pinned", pinned, s.pinned, row)
        for ((group, sessions) in s.groups) section("group:${group.id}", group.name, sessions, row, showEmpty = true)
        section("recent", if (query.isBlank()) recent else null, s.recent, row)
        if (s.archived.isNotEmpty()) {
            item(key = "archived") {
                SectionHeader(
                    archived,
                    expanded = archivedOpen,
                    onToggle = onToggleArchived,
                )
            }
            if (archivedOpen) items(s.archived, key = { "archived:${it.shortId}" }) { row(it) }
        }
    }
}

private fun LazyListScope.section(
    key: String,
    title: String?,
    sessions: List<SessionSummary>,
    row: @Composable (SessionSummary) -> Unit,
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
    items(sessions, key = { "$key:${it.shortId}" }) { row(it) }
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

/** 列表里"多久以前"按哪个时间算：列表变了就重新取一次。 */
@Composable
private fun now(state: SessionListState): Long = remember(state) { System.currentTimeMillis() }

/**
 * 一个会话一行：标题（普通文字，不当 Markdown）、主仓库、多久以前，右边是状态标记和"⋯"。
 * 长按也打开菜单（照 Claude 的 App）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    session: SessionSummary,
    now: Long,
    onOpen: (SessionSummary) -> Unit,
    onMenu: (SessionSummary) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = { onOpen(session) },
                onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onMenu(session)
                },
            )
            .padding(start = 20.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
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
        IconButton(onClick = { onMenu(session) }) {
            Icon(
                painterResource(R.drawable.ic_more_vert),
                contentDescription = stringResource(R.string.session_list_options, session.title),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
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
        SessionListScreen(SavedServer("p", "https://seekcloud.example.com"), state, false, false, {}, {}, {}, {}, {}, {})
    }
}

private const val TAB_SESSIONS = 0
private const val TAB_NEW = 1
private const val TAB_SETTINGS = 2
