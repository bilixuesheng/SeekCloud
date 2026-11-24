package cn.seekcloud.app.ui

import android.content.Intent
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import cn.seekcloud.app.BuildConfig
import cn.seekcloud.app.R
import cn.seekcloud.app.connect.Problem
import cn.seekcloud.app.connect.problemText
import cn.seekcloud.app.net.SavedServer

/** 新版本的下载页：本仓库在 GitHub 上发的版本（#125）。 */
const val DOWNLOAD_URL = "https://github.com/bilixuesheng/SeekCloud/releases/latest"

private val SavedServer.host: String
    get() = address?.host ?: origin

/** 登录以后的首页。会话列表（#124）做好以前，先放登录状态、换服务器和退出登录。 */
@Composable
fun HomeScreen(server: SavedServer, nickname: String?, onSwitchServer: () -> Unit, onSignOut: () -> Unit) {
    var confirm by rememberSaveable { mutableStateOf(false) }
    Page {
        PageHeader(
            title = nickname?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.home_greeting, it) }
                ?: stringResource(R.string.app_name),
            hint = stringResource(R.string.home_signed_in, server.host),
        )
        PrimaryButton(stringResource(R.string.switch_server), "", busy = false, onClick = onSwitchServer)
        Spacer(Modifier.height(8.dp))
        SecondaryButton(stringResource(R.string.sign_out)) { confirm = true }
    }
    if (confirm) {
        ConfirmDialog(
            title = stringResource(R.string.sign_out_title),
            body = stringResource(R.string.sign_out_body, server.host),
            confirm = stringResource(R.string.sign_out),
            onConfirm = {
                confirm = false
                onSignOut()
            },
            onDismiss = { confirm = false },
        )
    }
}

/** 主站连不上（#205）：说明原因，能重试、改地址（主站换了域名）、换服务器。 */
@Composable
fun OfflineScreen(
    server: SavedServer,
    problem: Problem,
    retrying: Boolean,
    onRetry: () -> Unit,
    onEditAddress: () -> Unit,
    onSwitchServer: () -> Unit,
) {
    Page {
        PageHeader(stringResource(R.string.offline_title), server.host)
        Notice(problemText(problem), error = true)
        Spacer(Modifier.height(24.dp))
        PrimaryButton(
            text = stringResource(R.string.offline_retry),
            busyText = stringResource(R.string.offline_retrying),
            busy = retrying,
            onClick = onRetry,
        )
        Spacer(Modifier.height(8.dp))
        SecondaryButton(stringResource(R.string.offline_edit_address), enabled = !retrying, onClick = onEditAddress)
        SecondaryButton(stringResource(R.string.switch_server), enabled = !retrying, onClick = onSwitchServer)
    }
}

/** 主站要求更高的 App 版本：去下载新版本（#125），或者换一台服务器。 */
@Composable
fun UpdateRequiredScreen(
    server: SavedServer,
    required: String,
    retrying: Boolean,
    onRetry: () -> Unit,
    onSwitchServer: () -> Unit,
) {
    val context = LocalContext.current
    Page {
        PageHeader(
            stringResource(R.string.update_title),
            stringResource(R.string.update_body, server.host, required, BuildConfig.VERSION_NAME),
        )
        PrimaryButton(stringResource(R.string.update_download), "", busy = false) {
            context.startActivity(Intent(Intent.ACTION_VIEW, DOWNLOAD_URL.toUri()))
        }
        Spacer(Modifier.height(8.dp))
        SecondaryButton(stringResource(R.string.offline_retry), enabled = !retrying, onClick = onRetry)
        SecondaryButton(stringResource(R.string.switch_server), enabled = !retrying, onClick = onSwitchServer)
    }
}

@Preview
@Composable
private fun OfflinePreview() {
    SeekCloudTheme {
        OfflineScreen(SavedServer("p", "https://seekcloud.example.com"), Problem.Unreachable, false, {}, {}, {})
    }
}

@Preview
@Composable
private fun HomePreview() {
    SeekCloudTheme { HomeScreen(SavedServer("p", "https://seekcloud.example.com"), "管理员", {}, {}) }
}
