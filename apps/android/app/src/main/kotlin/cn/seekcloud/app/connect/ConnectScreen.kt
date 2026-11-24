package cn.seekcloud.app.connect

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.seekcloud.app.R
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerTrust
import cn.seekcloud.app.ui.ConfirmDialog
import cn.seekcloud.app.ui.Page
import cn.seekcloud.app.ui.PageHeader
import cn.seekcloud.app.ui.PrimaryButton
import cn.seekcloud.app.ui.SecondaryButton
import cn.seekcloud.app.ui.SeekCloudTheme

/**
 * "连接服务器"页（#204）：第一次打开、添加服务器时显示；[editing] 时是给已经存着的一台改地址（#205）。
 * 连上以后交给 [onConnected]（去登录页或首页）。[onBack] 为 null 时没有上一页（第一次打开）。
 */
@Composable
fun ConnectRoute(
    editing: SavedServer?,
    autoConnect: Boolean,
    signedIn: Boolean,
    onConnected: (ConnectState.Connected) -> Unit,
    onBack: (() -> Unit)?,
) {
    val viewModel: ConnectViewModel = viewModel(key = "connect:${editing?.id}")
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(state) {
        val connected = state as? ConnectState.Connected ?: return@LaunchedEffect
        viewModel.reset(force = true)
        onConnected(connected)
    }
    ConnectScreen(
        state = state,
        initialAddress = editing?.origin.orEmpty(),
        editingHost = editing?.address?.host?.takeIf { signedIn },
        editing = editing != null,
        autoConnect = autoConnect,
        onConnect = { viewModel.connect(it, editing?.id) },
        onReset = viewModel::reset,
        onAllowCleartext = viewModel::allowCleartext,
        onTrustCertificate = viewModel::trustCertificate,
        onBack = onBack,
    )
}

/**
 * @param editingHost 改地址、而且这台已经登录时，原来的主机名：新地址换了主机就先确认"沿用登录状态"，
 *   免得令牌被带到填错的地址上。
 */
@Composable
fun ConnectScreen(
    state: ConnectState,
    initialAddress: String,
    onConnect: (String) -> Unit,
    onReset: () -> Unit,
    onAllowCleartext: () -> Unit,
    onTrustCertificate: () -> Unit,
    editing: Boolean = false,
    editingHost: String? = null,
    autoConnect: Boolean = false,
    onBack: (() -> Unit)? = null,
) {
    var address by rememberSaveable { mutableStateOf(initialAddress) }
    var autoDone by rememberSaveable { mutableStateOf(false) }
    var confirmMove by rememberSaveable { mutableStateOf<String?>(null) }
    val connecting = state == ConnectState.Connecting
    val submit: () -> Unit = submit@{
        if (address.isBlank() || connecting) return@submit
        val host = ServerAddress.parse(address)?.host
        if (editingHost != null && host != null && host != editingHost) confirmMove = host else onConnect(address)
    }
    LaunchedEffect(Unit) {
        if (autoConnect && !autoDone && address.isNotBlank()) {
            autoDone = true
            onConnect(address)
        }
    }
    if (onBack != null) BackHandler(enabled = !connecting, onBack = onBack)

    Page {
        PageHeader(
            title = stringResource(if (editing) R.string.connect_edit_title else R.string.connect_title),
            hint = stringResource(if (editing) R.string.connect_edit_hint else R.string.connect_hint),
        )
        val problem = (state as? ConnectState.Failed)?.problem
        OutlinedTextField(
            value = address,
            onValueChange = {
                address = it
                onReset()
            },
            label = { Text(stringResource(R.string.connect_address)) },
            singleLine = true,
            enabled = !connecting,
            isError = problem != null,
            supportingText = problem?.let {
                { Text(problemText(it), Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Go,
            ),
            keyboardActions = KeyboardActions(onGo = { submit() }),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        PrimaryButton(
            text = stringResource(R.string.connect_button),
            busyText = stringResource(R.string.connect_connecting),
            busy = connecting,
            enabled = address.isNotBlank(),
            onClick = submit,
        )
        if (onBack != null) {
            Spacer(Modifier.height(8.dp))
            SecondaryButton(stringResource(R.string.cancel), enabled = !connecting, onClick = onBack)
        }
    }

    confirmMove?.let { host ->
        ConfirmDialog(
            title = stringResource(R.string.connect_move_title),
            body = stringResource(R.string.connect_move_body, host),
            confirm = stringResource(R.string.connect_move_confirm),
            onConfirm = {
                confirmMove = null
                onConnect(address)
            },
            onDismiss = { confirmMove = null },
        )
    }

    when (state) {
        is ConnectState.AskCleartext -> ConfirmDialog(
            title = stringResource(R.string.connect_cleartext_title),
            body = stringResource(R.string.connect_cleartext_body),
            confirm = stringResource(R.string.connect_cleartext_confirm),
            onConfirm = onAllowCleartext,
            onDismiss = onReset,
        )
        is ConnectState.AskCertificate -> ConfirmDialog(
            title = stringResource(
                if (state.changed) R.string.connect_cert_changed_title else R.string.connect_cert_title,
            ),
            body = stringResource(
                if (state.changed) R.string.connect_cert_changed_body else R.string.connect_cert_body,
            ),
            confirm = stringResource(R.string.connect_cert_trust),
            onConfirm = onTrustCertificate,
            onDismiss = onReset,
        ) {
            Spacer(Modifier.height(16.dp))
            Text(
                stringResource(R.string.connect_cert_fingerprint),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            SelectionContainer {
                Text(
                    fingerprintLines(state.fingerprint),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        else -> Unit
    }
}

/** 连不上的原因怎么说（"连接服务器"页和出错页共用）。 */
@Composable
fun problemText(problem: Problem): String = when (problem) {
    Problem.Invalid -> stringResource(R.string.connect_invalid)
    Problem.Unreachable -> stringResource(R.string.connect_unreachable)
    Problem.NotSeekCloud -> stringResource(R.string.connect_not_seekcloud)
    Problem.Unavailable -> stringResource(R.string.connect_unavailable)
    Problem.TlsFailure -> stringResource(R.string.connect_tls_failure)
    is Problem.AppTooOld -> stringResource(R.string.connect_app_too_old, problem.required)
}

/** 指纹每 8 个字节一行，好和服务器上的对着看。 */
internal fun fingerprintLines(fingerprint: String): String =
    fingerprint.split(':').chunked(8).joinToString("\n") { it.joinToString(":") }

@Preview
@Composable
private fun ConnectPreview() {
    SeekCloudTheme {
        ConnectScreen(ConnectState.Failed(Problem.NotSeekCloud), "seekcloud.example.com", {}, {}, {}, {})
    }
}

@Preview
@Composable
private fun CertificatePreview() {
    val address = ServerAddress(true, "192.168.1.5", 8443)
    val fingerprint = (0 until 32).joinToString(":") { "%02X".format(it * 7) }
    SeekCloudTheme {
        ConnectScreen(
            ConnectState.AskCertificate(address, ServerTrust(), fingerprint, changed = true),
            address.origin,
            {}, {}, {}, {},
        )
    }
}

@Preview
@Composable
private fun EditPreview() {
    SeekCloudTheme {
        ConnectScreen(ConnectState.Idle, "https://seekcloud.example.com", {}, {}, {}, {}, editing = true, onBack = {})
    }
}
