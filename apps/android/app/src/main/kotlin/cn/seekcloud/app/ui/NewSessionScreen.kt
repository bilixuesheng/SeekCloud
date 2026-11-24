package cn.seekcloud.app.ui

import android.content.Intent
import android.text.format.DateUtils
import androidx.compose.foundation.Canvas
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import cn.seekcloud.app.sessions.GreetingSet
import cn.seekcloud.app.sessions.pickGreeting
import java.time.Instant
import java.util.Calendar
import kotlin.random.Random
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.seekcloud.app.R
import cn.seekcloud.app.net.errorTexts
import cn.seekcloud.app.net.failureText
import cn.seekcloud.app.sessions.Environment
import cn.seekcloud.app.sessions.ModelList
import cn.seekcloud.app.sessions.ModelOption
import cn.seekcloud.app.sessions.NewSessionUi
import cn.seekcloud.app.sessions.NewSessionViewModel
import cn.seekcloud.app.sessions.Repo
import cn.seekcloud.app.sessions.RepoSearch
import cn.seekcloud.app.sessions.SessionSummary
import cn.seekcloud.app.sessions.THINKING_EFFORTS
import kotlin.math.roundToInt

/** 正在选哪一项（底部弹层）。 */
private enum class Picker { None, Environment, Repo, Branch, Model }

/**
 * 新会话页（#124，照网页的 NewSession）：写一句话，选环境、仓库（可以不选）、分支、模型和思考强度，发起会话。
 * 发起以后交给 [onCreated]，按返回回到会话列表。
 */
@Composable
fun NewSessionRoute(
    origin: String,
    viewModel: NewSessionViewModel,
    nickname: String?,
    waiting: List<SessionSummary>,
    onOpen: (SessionSummary) -> Unit,
    onCreated: (SessionSummary) -> Unit,
    onBack: (() -> Unit)?,
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val repos by viewModel.repos.collectAsStateWithLifecycle()
    LaunchedEffect(ui.created) {
        val session = ui.created ?: return@LaunchedEffect
        viewModel.consumeCreated()
        onCreated(session)
    }
    NewSessionScreen(
        origin = origin,
        ui = ui,
        repos = repos,
        nickname = nickname,
        waiting = waiting,
        onOpen = onOpen,
        onText = viewModel::setText,
        onEnvironment = viewModel::setEnvironment,
        onRepo = viewModel::pickRepo,
        onSearchRepos = viewModel::searchRepos,
        onBranch = viewModel::setBranch,
        onModel = viewModel::setModel,
        onSubmit = viewModel::create,
        onBack = onBack,
    )
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun NewSessionScreen(
    origin: String,
    ui: NewSessionUi,
    repos: RepoSearch,
    onText: (String) -> Unit,
    onEnvironment: (String) -> Unit,
    onRepo: (Repo?) -> Unit,
    onSearchRepos: (String) -> Unit,
    onBranch: (String) -> Unit,
    onModel: (String, String) -> Unit,
    onSubmit: () -> Unit,
    onBack: (() -> Unit)?,
    nickname: String? = null,
    waiting: List<SessionSummary> = emptyList(),
    onOpen: (SessionSummary) -> Unit = {},
) {
    var picker by rememberSaveable { mutableStateOf(Picker.None) }
    val context = LocalContext.current
    if (onBack != null) BackHandler(enabled = !ui.busy, onBack = onBack)
    val greeting = rememberGreeting(nickname)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.sidebar_new_session)) },
                navigationIcon = {
                    // 宽屏时新会话页一直在右边，没有返回
                    if (onBack != null) {
                        IconButton(onClick = onBack, enabled = !ui.busy) {
                            Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = stringResource(R.string.common_back))
                        }
                    }
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(painterResource(R.drawable.whale), contentDescription = null, modifier = Modifier.size(64.dp))
            Spacer(Modifier.height(12.dp))
            Text(
                greeting,
                style = MaterialTheme.typography.headlineSmall,
                fontFamily = FontFamily.Serif,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Spacer(Modifier.height(16.dp))
            // 问候语下方：有会话在等你输入时提示一行（照网页的 AwaitingInputHint）
            if (waiting.isNotEmpty()) {
                AwaitingHint(waiting, onOpen)
                Spacer(Modifier.height(12.dp))
            }
            if (ui.github != null && !ui.connected) {
                GitHubCard { context.startActivity(Intent(Intent.ACTION_VIEW, "$origin/settings/github".toUri())) }
                Spacer(Modifier.height(16.dp))
            }
            OutlinedTextField(
                value = ui.text,
                onValueChange = onText,
                placeholder = { Text(stringResource(R.string.new_session_placeholder)) },
                enabled = !ui.busy,
                minLines = 4,
                modifier = Modifier.fillMaxWidth().widthIn(max = 640.dp).heightIn(min = 120.dp),
            )
            Spacer(Modifier.height(12.dp))
            // 输入框下面：环境、仓库、分支，再是模型和思考强度
            FlowRow(
                Modifier.fillMaxWidth().widthIn(max = 640.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (ui.githubChecked) {
                    if (ui.environments.isNotEmpty()) {
                        val env = ui.environments.firstOrNull { it.id == ui.environmentId }
                        Chip(R.drawable.ic_folder, env?.let { environmentName(it) } ?: stringResource(R.string.environment_label)) {
                            picker = Picker.Environment
                        }
                    }
                    // 没关联 GitHub 时只能不使用仓库（上面有关联 GitHub 的卡片）
                    if (ui.connected) {
                        val repo = ui.repo
                        Chip(
                            R.drawable.ic_call_split,
                            repo?.fullName ?: stringResource(R.string.new_session_no_repo),
                            badge = if (repo != null && !repo.canPush) stringResource(R.string.repo_read_only) else null,
                        ) { picker = Picker.Repo }
                    }
                    if (ui.chosenRepo != null) {
                        Chip(R.drawable.ic_call_split, ui.branch.orEmpty()) { picker = Picker.Branch }
                    }
                }
                val models = ui.models
                when {
                    // 一个能用的模型都没有（没填 key、提供方都停用了）：先去网页的设置里添加
                    models != null && models.models.isEmpty() -> Chip(R.drawable.ic_open_in_new, stringResource(R.string.new_session_choose_model)) {
                        context.startActivity(Intent(Intent.ACTION_VIEW, "$origin/settings/model".toUri()))
                    }
                    models != null -> {
                        val current = models.models.firstOrNull { it.id == ui.model }
                        val name = current?.let { modelName(it) }.orEmpty()
                        val label = if (current?.efforts?.isNotEmpty() == true) "$name · ${effortName(ui.effort)}" else name
                        Chip(R.drawable.ic_expand_more, label, description = stringResource(R.string.model_choose, name)) {
                            picker = Picker.Model
                        }
                    }
                }
            }
            ui.failure?.let {
                Spacer(Modifier.height(12.dp))
                Notice(failureText(it, LocalResources.current.errorTexts()), error = true)
            }
            Spacer(Modifier.height(16.dp))
            Row(Modifier.fillMaxWidth().widthIn(max = 640.dp), horizontalArrangement = Arrangement.End) {
                Box(Modifier.width(200.dp)) {
                    PrimaryButton(
                        text = stringResource(R.string.new_session_submit),
                        busyText = stringResource(R.string.common_please_wait),
                        busy = ui.busy,
                        enabled = ui.canSubmit,
                        onClick = onSubmit,
                    )
                }
            }
        }
    }

    when (picker) {
        Picker.Environment -> OptionSheet(
            title = stringResource(R.string.environment_label),
            options = ui.environments.map { it.id to environmentName(it) },
            selected = ui.environmentId,
            onPick = {
                onEnvironment(it)
                picker = Picker.None
            },
            onDismiss = { picker = Picker.None },
        )
        Picker.Branch -> OptionSheet(
            title = stringResource(R.string.new_session_base_branch),
            options = ui.branches.map { it to it },
            selected = ui.branch,
            searchLabel = stringResource(R.string.new_session_search_branches),
            emptyText = stringResource(R.string.new_session_no_branch_match),
            onPick = {
                onBranch(it)
                picker = Picker.None
            },
            onDismiss = { picker = Picker.None },
        )
        Picker.Repo -> RepoSheet(
            ui = ui,
            search = repos,
            onSearch = onSearchRepos,
            onPick = {
                onRepo(it)
                picker = Picker.None
            },
            onManage = { ui.github?.installUrl?.takeIf { it.isNotBlank() }?.let { context.startActivity(Intent(Intent.ACTION_VIEW, it.toUri())) } },
            onDismiss = { picker = Picker.None },
        )
        Picker.Model -> ui.models?.let { models ->
            ModelSheet(
                models = models,
                model = ui.model.orEmpty(),
                effort = ui.effort,
                onChange = onModel,
                onDismiss = { picker = Picker.None },
            )
        }
        Picker.None -> Unit
    }
}

/** 没关联 GitHub 时：说明，再到网页上关联（GitHub 授权要在浏览器里做，完成以后回到 App 刷新）。 */
@Composable
private fun GitHubCard(onOpen: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().widthIn(max = 640.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(R.string.github_connect_title), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.github_connect_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onOpen) { Text(stringResource(R.string.login_open_browser)) }
        }
    }
}

@Composable
private fun Chip(icon: Int, text: String, badge: String? = null, description: String? = null, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        label = {
            Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp))
            if (badge != null) {
                Spacer(Modifier.width(6.dp))
                Text(badge, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
        },
        leadingIcon = { Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(16.dp)) },
        modifier = if (description != null) Modifier.semantics { contentDescription = description } else Modifier,
    )
}

/** 打开这一页时挑一句问候语，转屏不换。 */
@Composable
private fun rememberGreeting(nickname: String?): String {
    val resources = LocalResources.current
    return rememberSaveable(nickname) {
        val set = runCatching {
            resources.openRawResource(R.raw.greetings).bufferedReader().use { GreetingSet.parse(it.readText()) }
        }.getOrNull()
        if (set == null) {
            ""
        } else {
            val now = Calendar.getInstance()
            pickGreeting(
                set,
                nickname,
                now.get(Calendar.HOUR_OF_DAY),
                now.get(Calendar.DAY_OF_WEEK) - 1,
                Random.nextDouble(),
            )
        }
    }
}

/** 等你输入的会话：一个时写标题，点了打开它；多个时写"有 N 个会话在等你输入"，点了展开列表。 */
@Composable
private fun AwaitingHint(waiting: List<SessionSummary>, onOpen: (SessionSummary) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    val only = waiting.singleOrNull()
    val primary = MaterialTheme.colorScheme.primary
    Card(
        Modifier.fillMaxWidth().widthIn(max = 640.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { if (only != null) onOpen(only) else open = !open }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Canvas(Modifier.size(14.dp)) {
                drawCircle(primary, radius = 6.dp.toPx(), style = Stroke(width = 1.5.dp.toPx()))
                drawCircle(primary, radius = 2.5.dp.toPx())
            }
            Spacer(Modifier.width(10.dp))
            Text(
                if (only != null) {
                    stringResource(R.string.awaiting_one, only.title)
                } else {
                    pluralStringResource(R.plurals.awaiting_many, waiting.size, waiting.size)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (only == null) {
                Icon(
                    painterResource(if (open) R.drawable.ic_expand_less else R.drawable.ic_expand_more),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }
        if (only == null && open) {
            val now = System.currentTimeMillis()
            for (session in waiting) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { onOpen(session) }
                        .padding(start = 40.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        session.title,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    waitedFor(session.updatedAt, now)?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** 等了多久（"3 分钟前"这类，跟着系统语言）。 */
private fun waitedFor(iso: String, now: Long): String? = runCatching {
    DateUtils.getRelativeTimeSpanString(Instant.parse(iso).toEpochMilli(), now, DateUtils.MINUTE_IN_MILLIS).toString()
}.getOrNull()

@Composable
private fun environmentName(env: Environment): String = env.name.ifBlank { stringResource(R.string.environment_default) }

/** 一列选项的底部弹层；[searchLabel] 不为空时上面有搜索框（不自动弹出输入法，免得挡住列表）。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OptionSheet(
    title: String,
    options: List<Pair<String, String>>,
    selected: String?,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
    searchLabel: String? = null,
    emptyText: String? = null,
) {
    var query by rememberSaveable { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
            SheetTitle(title)
            if (searchLabel != null) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(searchLabel) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            val shown = options.filter { it.second.contains(query.trim(), ignoreCase = true) }
            if (shown.isEmpty() && emptyText != null) SheetEmpty(emptyText)
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(shown, key = { it.first }) { (value, text) ->
                    SheetRow(text, selected = value == selected) { onPick(value) }
                }
            }
        }
    }
}

/** 选仓库（照网页的 RepoPicker）：不使用仓库、装了 App 的仓库，搜的时候加上搜到的公开仓库；下面是管理仓库权限。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RepoSheet(
    ui: NewSessionUi,
    search: RepoSearch,
    onSearch: (String) -> Unit,
    onPick: (Repo?) -> Unit,
    onManage: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 8.dp)) {
            SheetTitle(stringResource(R.string.repo_picker_title))
            OutlinedTextField(
                value = search.query,
                onValueChange = onSearch,
                placeholder = { Text(stringResource(R.string.repo_picker_search)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            )
            search.failure?.let { Notice(failureText(it, LocalResources.current.errorTexts()), error = true) }
            val repos = search.repos
            if (repos != null && repos.isEmpty()) {
                SheetEmpty(stringResource(if (search.query.isBlank()) R.string.repo_picker_empty else R.string.repo_picker_no_match))
            }
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                // 不使用仓库（#191）：沙箱里不克隆，Agent 在空的工作目录里工作
                if (search.query.isBlank()) {
                    item(key = "none") { SheetRow(stringResource(R.string.new_session_no_repo), selected = ui.repo == null) { onPick(null) } }
                }
                items(repos.orEmpty(), key = { it.fullName }) { repo ->
                    val badges = listOfNotNull(
                        if (repo.private) stringResource(R.string.repo_private) else null,
                        if (!repo.canPush) stringResource(R.string.repo_read_only) else null,
                    )
                    SheetRow(repo.fullName, sub = badges.joinToString(" · ").ifBlank { null }, selected = ui.repo?.fullName == repo.fullName) {
                        onPick(repo)
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    ui.github?.login.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onManage) { Text(stringResource(R.string.repo_picker_manage)) }
            }
        }
    }
}

/** 模型和思考强度（照网页的 ModelPicker，#20）：模型按提供方分组，下面是只画这个模型支持的几档的滑块。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ModelSheet(models: ModelList, model: String, effort: String, onChange: (String, String) -> Unit, onDismiss: () -> Unit) {
    val current = models.models.firstOrNull { it.id == model }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
            SheetTitle(stringResource(R.string.model_dialog))
            if (current != null) EffortSlider(current, effort, models.defaultEffort) { onChange(current.id, it) }
            Text(
                stringResource(R.string.model_list),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 24.dp, top = 12.dp, bottom = 4.dp),
            )
            LazyColumn(Modifier.heightIn(max = 380.dp)) {
                for ((provider, list) in models.models.groupBy { it.provider }) {
                    item(key = "provider:$provider") {
                        Text(
                            providerName(provider, list.first().providerName),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 24.dp, top = 8.dp, bottom = 2.dp),
                        )
                    }
                    items(list, key = { it.id }) { option ->
                        SheetRow(modelName(option), sub = modelDescription(option), selected = option.id == model) {
                            // 换模型时思考强度沿用现在的那一档（新模型不支持就换成最近的一档，调用方用 fitEffort 定）
                            onChange(option.id, effort)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EffortSlider(model: ModelOption, effort: String, defaultEffort: String, onChange: (String) -> Unit) {
    Column(Modifier.padding(horizontal = 24.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.model_effort), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            if (model.efforts.isNotEmpty()) {
                Text(effortName(effort), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                if (effort != defaultEffort && defaultEffort in model.efforts) {
                    TextButton(onClick = { onChange(defaultEffort) }) { Text(stringResource(R.string.model_reset_effort)) }
                }
            }
        }
        if (model.efforts.isEmpty()) {
            Text(
                stringResource(R.string.model_no_efforts, modelName(model)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }
        // 每个模型只画自己支持的几档（2026-11-22 定的）
        val efforts = model.efforts.sortedBy { THINKING_EFFORTS.indexOf(it) }
        val index = efforts.indexOf(effort).coerceAtLeast(0)
        val label = effortName(effort)
        if (efforts.size > 1) {
            Slider(
                value = index.toFloat(),
                onValueChange = { onChange(efforts[it.roundToInt().coerceIn(efforts.indices)]) },
                valueRange = 0f..(efforts.size - 1).toFloat(),
                steps = (efforts.size - 2).coerceAtLeast(0),
                modifier = Modifier.semantics { stateDescription = label },
            )
        }
        if (effort == "max") {
            Text(stringResource(R.string.model_max_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun effortName(effort: String): String = stringResource(
    when (effort) {
        "minimal" -> R.string.effort_minimal
        "low" -> R.string.effort_low
        "medium" -> R.string.effort_medium
        "high" -> R.string.effort_high
        "xhigh" -> R.string.effort_xhigh
        "max" -> R.string.effort_max
        else -> R.string.effort_off
    },
)

internal fun modelName(model: ModelOption): String = model.name.ifBlank { model.id.substringAfter('/') }

/** 内置的 DeepSeek 两个模型有说明（照网页）。 */
@Composable
private fun modelDescription(model: ModelOption): String? = when (model.id) {
    "deepseek/deepseek-flash" -> stringResource(R.string.model_desc_flash)
    "deepseek/deepseek-v4-pro" -> stringResource(R.string.model_desc_pro)
    else -> null
}

/** 提供方给人看的名字（照网页的 providerLabel）：默认名字按界面语言写，管理员起的照写，都没有时用 ID。 */
@Composable
private fun providerName(id: String, name: String): String {
    val defaults = mapOf(
        "deepseek" to ("DeepSeek" to R.string.models_deepseek_name),
        "moonshotai" to ("Kimi (Moonshot)" to R.string.models_provider_name_moonshotai),
        "moonshotai-cn" to ("Kimi (Moonshot China)" to R.string.models_provider_name_moonshotai_cn),
        "zai" to ("Zhipu GLM (Z.ai)" to R.string.models_provider_name_zai),
        "zai-coding-cn" to ("Zhipu GLM (China)" to R.string.models_provider_name_zai_coding_cn),
        "minimax-cn" to ("MiniMax (China)" to R.string.models_provider_name_minimax_cn),
        "xiaomi" to ("Xiaomi MiMo" to R.string.models_provider_name_xiaomi),
    )
    val entry = defaults[id]
    if (entry != null && (name.isBlank() || name == entry.first)) return stringResource(entry.second)
    return name.ifBlank { id }
}

@Composable
private fun SheetTitle(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() },
    )
}

@Composable
private fun SheetEmpty(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
    )
}

@Composable
private fun SheetRow(text: String, selected: Boolean, sub: String? = null, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(text, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (selected) {
            Icon(painterResource(R.drawable.ic_check), contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        }
    }
}
