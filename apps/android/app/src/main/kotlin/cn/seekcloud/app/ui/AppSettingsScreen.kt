package cn.seekcloud.app.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import cn.seekcloud.app.R
import cn.seekcloud.app.net.SavedServer

/**
 * 底栏"设置"那一页（#178）：先放 App 自己的几项（玻璃效果、服务器、退出登录），设置的其余分类照网页做是 #181，
 * 那之前给一个"在网页上打开设置"的入口。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppSettingsScreen(
    server: SavedServer,
    glass: GlassStyle,
    render: GlassRender,
    onGlass: (GlassStyle) -> Unit,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
    bottomInset: Dp,
) {
    val context = LocalContext.current
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    val host = server.address?.host ?: server.origin
    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.settings_title)) }) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(bottom = bottomInset),
        ) {
            SectionTitle(stringResource(R.string.settings_appearance))
            Text(
                stringResource(R.string.settings_glass),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
            )
            GlassOption(
                title = stringResource(R.string.settings_glass_colorful),
                hint = stringResource(R.string.settings_glass_colorful_hint),
                selected = glass == GlassStyle.Colorful,
            ) { onGlass(GlassStyle.Colorful) }
            GlassOption(
                title = stringResource(R.string.settings_glass_plain),
                hint = stringResource(R.string.settings_glass_plain_hint),
                selected = glass == GlassStyle.Plain,
            ) { onGlass(GlassStyle.Plain) }
            if (render != GlassRender.Liquid) {
                Text(
                    stringResource(R.string.settings_glass_frosted),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                )
            }

            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.outlineVariant)
            SectionTitle(stringResource(R.string.settings_server))
            Text(host, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp))
            SettingsRow(stringResource(R.string.switch_server), onClick = onSwitchServer)
            SettingsRow(stringResource(R.string.settings_web), hint = stringResource(R.string.settings_web_hint)) {
                context.startActivity(Intent(Intent.ACTION_VIEW, "${server.origin}/settings".toUri()))
            }
            SettingsRow(stringResource(R.string.sign_out), danger = true) { confirmSignOut = true }
            Spacer(Modifier.height(24.dp))
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

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() },
    )
}

@Composable
private fun GlassOption(title: String, hint: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(Modifier.padding(start = 8.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SettingsRow(title: String, hint: String? = null, danger: Boolean = false, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
