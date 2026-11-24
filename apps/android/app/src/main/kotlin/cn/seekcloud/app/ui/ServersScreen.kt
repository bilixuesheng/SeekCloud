package cn.seekcloud.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import cn.seekcloud.app.R
import cn.seekcloud.app.net.SavedServer

/**
 * 保存的服务器（#205）：点一台换过去，各自的登录状态互不影响；可以添加、删除。
 * 以后设置的"App"一类里也放这一页（#181）。
 */
@Composable
fun ServersScreen(
    servers: List<SavedServer>,
    currentId: String?,
    signedIn: (SavedServer) -> Boolean,
    onSelect: (SavedServer) -> Unit,
    onAdd: () -> Unit,
    onRemove: (SavedServer) -> Unit,
    onBack: (() -> Unit)?,
) {
    var removing by rememberSaveable { mutableStateOf<String?>(null) }
    if (onBack != null) BackHandler(onBack = onBack)
    Page {
        PageHeader(stringResource(R.string.servers_title), whale = 72.dp)
        Column(Modifier.fillMaxWidth()) {
            servers.forEachIndexed { index, server ->
                if (index > 0) HorizontalDivider()
                ServerRow(
                    server = server,
                    status = stringResource(
                        when {
                            server.id == currentId -> R.string.servers_current
                            signedIn(server) -> R.string.servers_signed_in
                            else -> R.string.servers_signed_out
                        },
                    ),
                    onSelect = { onSelect(server) },
                    onRemove = { removing = server.id },
                )
            }
        }
        Spacer(Modifier.height(24.dp))
        PrimaryButton(stringResource(R.string.servers_add), "", busy = false, onClick = onAdd)
        if (onBack != null) {
            Spacer(Modifier.height(8.dp))
            SecondaryButton(stringResource(R.string.back), onClick = onBack)
        }
    }
    servers.firstOrNull { it.id == removing }?.let { server ->
        ConfirmDialog(
            title = stringResource(R.string.servers_remove_title),
            body = stringResource(R.string.servers_remove_body, server.address?.host ?: server.origin),
            confirm = stringResource(R.string.servers_remove),
            onConfirm = {
                removing = null
                onRemove(server)
            },
            onDismiss = { removing = null },
        )
    }
}

@Composable
private fun ServerRow(server: SavedServer, status: String, onSelect: () -> Unit, onRemove: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onSelect)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(Modifier.weight(1f).padding(start = 4.dp)) {
            Text(
                server.address?.host ?: server.origin,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${server.origin} · $status",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        TextButton(onClick = onRemove) {
            Text(stringResource(R.string.servers_remove), color = MaterialTheme.colorScheme.error)
        }
    }
}

@Preview
@Composable
private fun ServersPreview() {
    val servers = listOf(
        SavedServer("a", "https://seekcloud.example.com"),
        SavedServer("b", "http://192.168.1.5:8080", allowCleartext = true),
    )
    SeekCloudTheme { ServersScreen(servers, "a", { it.id == "a" }, {}, {}, {}, {}) }
}
