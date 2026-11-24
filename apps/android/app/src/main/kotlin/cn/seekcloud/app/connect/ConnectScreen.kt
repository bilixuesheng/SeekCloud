package cn.seekcloud.app.connect

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.seekcloud.app.R
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerTrust
import cn.seekcloud.app.ui.SeekCloudTheme

/** "连接服务器"页（#204）：第一次打开、还没有保存的主站时显示。连上以后去登录（#205）。 */
@Composable
fun ConnectRoute(viewModel: ConnectViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    ConnectScreen(
        state = state,
        initialAddress = viewModel.savedOrigin.orEmpty(),
        onConnect = viewModel::connect,
        onReset = viewModel::reset,
        onAllowCleartext = viewModel::allowCleartext,
        onTrustCertificate = viewModel::trustCertificate,
    )
}

@Composable
fun ConnectScreen(
    state: ConnectState,
    initialAddress: String,
    onConnect: (String) -> Unit,
    onReset: () -> Unit,
    onAllowCleartext: () -> Unit,
    onTrustCertificate: () -> Unit,
) {
    var address by rememberSaveable { mutableStateOf(initialAddress) }
    val connecting = state == ConnectState.Connecting
    val submit = { if (address.isNotBlank() && !connecting) onConnect(address) }
    // 连上以后地址框里换成规整后的地址（主站让从 http 升到 https 时也看得出来）
    LaunchedEffect(state) { if (state is ConnectState.Connected) address = state.server.origin }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
            Column(
                Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 32.dp)
                    .widthIn(max = 440.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Image(
                    painter = painterResource(R.drawable.whale),
                    contentDescription = null,
                    modifier = Modifier.size(96.dp),
                )
                Spacer(Modifier.height(20.dp))
                Text(stringResource(R.string.connect_title), style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(R.string.connect_hint),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(24.dp))
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
                Button(
                    onClick = submit,
                    enabled = address.isNotBlank() && !connecting,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    if (connecting) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                                color = LocalContentColor.current,
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(stringResource(R.string.connect_connecting))
                        }
                    } else {
                        Text(stringResource(R.string.connect_button))
                    }
                }
                if (state is ConnectState.Connected) {
                    Spacer(Modifier.height(16.dp))
                    Text(
                        stringResource(R.string.connect_connected, state.address.host),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
        }
    }

    when (state) {
        is ConnectState.AskCleartext -> RiskDialog(
            title = stringResource(R.string.connect_cleartext_title),
            body = stringResource(R.string.connect_cleartext_body),
            confirm = stringResource(R.string.connect_cleartext_confirm),
            onConfirm = onAllowCleartext,
            onDismiss = onReset,
        )
        is ConnectState.AskCertificate -> RiskDialog(
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

/** 要管理员接受风险的确认：确认的按钮用醒目的颜色，"取消"在旁边。 */
@Composable
private fun RiskDialog(
    title: String,
    body: String,
    confirm: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    extra: @Composable () -> Unit = {},
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(body)
                extra()
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun problemText(problem: Problem): String = when (problem) {
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
private fun ConnectedPreview() {
    val address = ServerAddress(true, "seekcloud.example.com", null)
    SeekCloudTheme {
        ConnectScreen(ConnectState.Connected(address, SavedServer(address.origin)), address.origin, {}, {}, {}, {})
    }
}
