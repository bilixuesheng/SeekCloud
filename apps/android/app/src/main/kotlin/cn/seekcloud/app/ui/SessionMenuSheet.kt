package cn.seekcloud.app.ui

import android.content.ClipData
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import cn.seekcloud.app.R
import cn.seekcloud.app.net.errorTexts
import cn.seekcloud.app.net.failureText
import cn.seekcloud.app.sessions.MenuPage
import cn.seekcloud.app.sessions.MenuUi
import cn.seekcloud.app.sessions.PullRequestRef
import cn.seekcloud.app.sessions.SessionActions
import cn.seekcloud.app.sessions.SessionGroup
import cn.seekcloud.app.sessions.SessionSummary
import kotlinx.coroutines.launch

/**
 * 会话菜单（#124）：照网页的 SessionMenu，用底部弹层，里面分几页（打开方式、重命名、删除确认、移到分组、新分组）。
 * 每一项都走主站的接口，成功以后列表由事件流推回来的为准。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionMenuSheet(
    origin: String,
    session: SessionSummary,
    groups: List<SessionGroup>,
    menu: MenuUi,
    onPage: (MenuPage) -> Unit,
    onPerform: (SessionActions.(String) -> Unit) -> Unit,
    onCopied: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        // 子页按返回键回到菜单的第一页
        BackHandler(enabled = menu.page != MenuPage.Main && !menu.busy) {
            onPage(if (menu.page == MenuPage.NewGroup) MenuPage.Group else MenuPage.Main)
        }
        val failure = menu.failure?.let { failureText(it, LocalResources.current.errorTexts()) }
        AnimatedContent(
            targetState = menu.page,
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "menu page",
            modifier = Modifier.navigationBarsPadding(),
        ) { page ->
            Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
                when (page) {
                    MenuPage.Main -> MainPage(origin, session, menu.busy, onPage, onPerform, onCopied)
                    MenuPage.OpenOn -> OpenOnPage(session, onPage)
                    MenuPage.Rename -> RenamePage(session, menu.busy, onPage, onPerform)
                    MenuPage.Delete -> DeletePage(menu.busy, onPage, onPerform)
                    MenuPage.Group -> GroupPage(session, groups, menu.busy, onPage, onPerform)
                    MenuPage.NewGroup -> NewGroupPage(menu.busy, onPage, onPerform)
                }
                if (failure != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        failure,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(horizontal = 24.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun MainPage(
    origin: String,
    session: SessionSummary,
    busy: Boolean,
    onPage: (MenuPage) -> Unit,
    onPerform: (SessionActions.(String) -> Unit) -> Unit,
    onCopied: () -> Unit,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val archived = session.status == "archived"
    val pinned = session.pinnedAt != null
    val repo = session.repos.firstOrNull()
    val pr = repo?.pullRequest
    Text(
        session.title,
        style = MaterialTheme.typography.titleMedium,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() },
    )
    if (repo != null && pr != null) {
        MenuItem(R.drawable.ic_merge, stringResource(R.string.session_open_pr)) {
            context.openUrl("https://github.com/${repo.fullName}/pull/${pr.number}")
        }
    }
    if (!archived) {
        MenuItem(R.drawable.ic_push_pin, stringResource(if (pinned) R.string.session_unpin else R.string.session_pin), enabled = !busy) {
            onPerform { setPinned(it, !pinned) }
        }
        MenuItem(R.drawable.ic_folder, stringResource(R.string.session_move_to_group), more = true) {
            onPage(MenuPage.Group)
        }
    }
    MenuItem(
        if (session.unread) R.drawable.ic_mark_chat_read else R.drawable.ic_mark_chat_unread,
        stringResource(if (session.unread) R.string.session_mark_read else R.string.session_mark_unread),
        enabled = !busy,
    ) { onPerform { setUnread(it, !session.unread) } }
    // 不使用仓库的会话（#191）没有会话分支和 PR，没有可打开的
    if (session.repos.isNotEmpty()) {
        MenuItem(R.drawable.ic_open_in_new, stringResource(R.string.session_open_on), more = true) { onPage(MenuPage.OpenOn) }
    }
    MenuItem(R.drawable.ic_edit, stringResource(R.string.common_rename)) { onPage(MenuPage.Rename) }
    MenuItem(R.drawable.ic_link, stringResource(R.string.session_copy_link)) {
        scope.launch {
            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(session.title, "$origin/s/${session.shortId}")))
            onCopied()
        }
    }
    MenuItem(
        if (archived) R.drawable.ic_unarchive else R.drawable.ic_archive,
        stringResource(if (archived) R.string.session_unarchive else R.string.session_archive),
        enabled = !busy,
    ) { onPerform { if (archived) unarchive(it) else archive(it) } }
    HorizontalDivider(Modifier.padding(vertical = 4.dp))
    MenuItem(R.drawable.ic_delete, stringResource(R.string.common_delete), danger = true) { onPage(MenuPage.Delete) }
}

@Composable
private fun OpenOnPage(session: SessionSummary, onPage: (MenuPage) -> Unit) {
    val context = LocalContext.current
    PageBack(stringResource(R.string.session_open_on)) { onPage(MenuPage.Main) }
    for (repo in session.repos) {
        if (session.repos.size > 1) {
            Text(
                repo.fullName,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 6.dp),
            )
        }
        MenuItem(
            R.drawable.ic_call_split,
            repo.branch,
            sub = if (repo.access == "read") stringResource(R.string.session_read_only_repo) else null,
            mono = true,
        ) { context.openUrl("https://github.com/${repo.fullName}/tree/${repo.branch}") }
        repo.pullRequest?.let { pr ->
            MenuItem(R.drawable.ic_merge, pullRequestText(pr)) {
                context.openUrl("https://github.com/${repo.fullName}/pull/${pr.number}")
            }
        }
    }
}

@Composable
private fun pullRequestText(pr: PullRequestRef): String {
    val state = stringResource(
        when (pr.state) {
            "draft" -> R.string.pr_draft
            "merged" -> R.string.pr_merged
            "closed" -> R.string.pr_closed
            else -> R.string.pr_open
        },
    )
    return stringResource(R.string.pr_text, pr.number.toString(), state)
}

@Composable
private fun RenamePage(
    session: SessionSummary,
    busy: Boolean,
    onPage: (MenuPage) -> Unit,
    onPerform: (SessionActions.(String) -> Unit) -> Unit,
) {
    var title by rememberSaveable(session.shortId) { mutableStateOf(session.title) }
    val valid = title.isNotBlank() && title.trim().length <= 100
    val save = { if (valid && !busy) onPerform { rename(it, title) } }
    PageBack(stringResource(R.string.common_rename)) { onPage(MenuPage.Main) }
    OutlinedTextField(
        value = title,
        onValueChange = { title = it },
        label = { Text(stringResource(R.string.session_title_label)) },
        singleLine = true,
        enabled = !busy,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { save() }),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
    )
    SheetActions(
        confirm = stringResource(R.string.common_save),
        enabled = valid && !busy,
        onCancel = { onPage(MenuPage.Main) },
        onConfirm = save,
    )
}

@Composable
private fun DeletePage(busy: Boolean, onPage: (MenuPage) -> Unit, onPerform: (SessionActions.(String) -> Unit) -> Unit) {
    PageBack(stringResource(R.string.session_delete)) { onPage(MenuPage.Main) }
    Text(
        stringResource(R.string.session_delete_hint),
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.padding(horizontal = 24.dp),
    )
    SheetActions(
        confirm = stringResource(R.string.session_delete_forever),
        enabled = !busy,
        danger = true,
        onCancel = { onPage(MenuPage.Main) },
        onConfirm = { onPerform { delete(it) } },
    )
}

@Composable
private fun GroupPage(
    session: SessionSummary,
    groups: List<SessionGroup>,
    busy: Boolean,
    onPage: (MenuPage) -> Unit,
    onPerform: (SessionActions.(String) -> Unit) -> Unit,
) {
    PageBack(stringResource(R.string.session_move_to_group)) { onPage(MenuPage.Main) }
    for (group in groups.sortedBy { it.sortKey }) {
        val here = group.id == session.groupId
        MenuItem(if (here) R.drawable.ic_check else R.drawable.ic_folder, group.name, enabled = !busy && !here) {
            onPerform { moveToGroup(it, group.id) }
        }
    }
    MenuItem(R.drawable.ic_add, stringResource(R.string.sidebar_new_group), more = true) { onPage(MenuPage.NewGroup) }
    if (session.groupId != null) {
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        MenuItem(R.drawable.ic_folder, stringResource(R.string.session_remove_from_group), enabled = !busy) {
            onPerform { moveToGroup(it, null) }
        }
    }
}

@Composable
private fun NewGroupPage(busy: Boolean, onPage: (MenuPage) -> Unit, onPerform: (SessionActions.(String) -> Unit) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    // 和主站一样：去掉首尾空格以后不能为空，最长 40 个字
    val valid = name.isNotBlank() && name.trim().length <= 40
    val create = { if (valid && !busy) onPerform { moveToGroup(it, createGroup(name)) } }
    PageBack(stringResource(R.string.sidebar_new_group)) { onPage(MenuPage.Group) }
    OutlinedTextField(
        value = name,
        onValueChange = { name = it },
        label = { Text(stringResource(R.string.group_name)) },
        singleLine = true,
        enabled = !busy,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { create() }),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
    )
    SheetActions(
        confirm = stringResource(R.string.session_create_and_move),
        enabled = valid && !busy,
        onCancel = { onPage(MenuPage.Group) },
        onConfirm = create,
    )
}

@Composable
private fun MenuItem(
    icon: Int,
    text: String,
    enabled: Boolean = true,
    danger: Boolean = false,
    more: Boolean = false,
    sub: String? = null,
    mono: Boolean = false,
    onClick: () -> Unit,
) {
    val color = when {
        !enabled -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
        danger -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurface
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text,
                color = color,
                style = MaterialTheme.typography.bodyLarge,
                fontFamily = if (mono) FontFamily.Monospace else null,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (sub != null) {
                Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (more) {
            Icon(
                painterResource(R.drawable.ic_expand_more),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/** 子页的标题，左边是返回。 */
@Composable
private fun PageBack(title: String, onBack: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onBack)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = stringResource(R.string.common_back))
        Spacer(Modifier.width(12.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
    }
    Spacer(Modifier.height(4.dp))
}

@Composable
private fun SheetActions(
    confirm: String,
    enabled: Boolean,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
    danger: Boolean = false,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
    ) {
        OutlinedButton(onClick = onCancel) { Text(stringResource(R.string.common_cancel)) }
        Button(
            onClick = onConfirm,
            enabled = enabled,
            colors = if (danger) {
                ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = Color.White)
            } else {
                ButtonDefaults.buttonColors()
            },
        ) { Text(confirm) }
    }
}

/** 主站以外的链接（GitHub 上的分支、PR）一律交给系统浏览器打开（#204 的安全要求）。 */
private fun android.content.Context.openUrl(url: String) = startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
