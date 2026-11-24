package cn.seekcloud.app.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import cn.seekcloud.app.LoginUi
import cn.seekcloud.app.R
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.errorTexts
import cn.seekcloud.app.net.failureText

/**
 * 登录页（#205）：只有管理员密码（ADR 0008）。开了两步验证时第二步输验证码或恢复码；
 * 主站还没设置过密码时，提示先在网页上完成首次设置。
 */
@Composable
fun LoginScreen(
    server: SavedServer,
    signedOut: Boolean,
    ui: LoginUi,
    onCheckSetup: () -> Unit,
    onSignIn: (String) -> Unit,
    onVerify: (String) -> Unit,
    onCancelSecondFactor: () -> Unit,
    onEdited: () -> Unit,
    onSwitchServer: () -> Unit,
) {
    val host = server.address?.host ?: server.origin
    LaunchedEffect(server.id) { onCheckSetup() }
    val failure = ui.failure?.let { failureText(it, LocalResources.current.errorTexts()) }

    if (ui.pendingToken != null) {
        SecondFactor(ui, failure, onVerify, onCancelSecondFactor, onEdited)
        return
    }

    Page {
        PageHeader(stringResource(R.string.login_title), stringResource(R.string.login_server, host))
        when {
            ui.needsSetup -> {
                val context = LocalContext.current
                Notice(stringResource(R.string.login_setup_required))
                Spacer(Modifier.height(24.dp))
                PrimaryButton(stringResource(R.string.login_open_browser), "", busy = false) {
                    context.startActivity(Intent(Intent.ACTION_VIEW, server.origin.toUri()))
                }
                Spacer(Modifier.height(8.dp))
                SecondaryButton(stringResource(R.string.login_check_again), enabled = !ui.busy, onClick = onCheckSetup)
            }
            else -> {
                var password by rememberSaveable { mutableStateOf("") }
                val submit = { if (password.isNotEmpty() && !ui.busy) onSignIn(password) }
                if (signedOut) {
                    Notice(stringResource(R.string.login_signed_out))
                    Spacer(Modifier.height(16.dp))
                }
                OutlinedTextField(
                    value = password,
                    onValueChange = {
                        password = it
                        onEdited()
                    },
                    label = { Text(stringResource(R.string.login_password)) },
                    singleLine = true,
                    enabled = !ui.busy,
                    isError = failure != null,
                    supportingText = failure?.let { { Text(it) } },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                    // 让密码管理器认出这是密码框
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Password },
                )
                Spacer(Modifier.height(16.dp))
                PrimaryButton(
                    text = stringResource(R.string.login_button),
                    busyText = stringResource(R.string.login_signing_in),
                    busy = ui.busy,
                    enabled = password.isNotEmpty(),
                    onClick = submit,
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        SecondaryButton(stringResource(R.string.switch_server), enabled = !ui.busy, onClick = onSwitchServer)
    }
}

@Composable
private fun SecondFactor(
    ui: LoginUi,
    failure: String?,
    onVerify: (String) -> Unit,
    onCancel: () -> Unit,
    onEdited: () -> Unit,
) {
    var code by rememberSaveable { mutableStateOf("") }
    val submit = { if (code.isNotBlank() && !ui.busy) onVerify(code) }
    BackHandler(enabled = !ui.busy, onBack = onCancel)
    Page {
        PageHeader(stringResource(R.string.login_code_title), stringResource(R.string.login_code_hint))
        OutlinedTextField(
            value = code,
            onValueChange = {
                code = it
                onEdited()
            },
            label = { Text(stringResource(R.string.login_code)) },
            singleLine = true,
            enabled = !ui.busy,
            isError = failure != null,
            supportingText = failure?.let { { Text(it) } },
            // 恢复码里有字母和连字符，不用纯数字键盘
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.SmsOtpCode },
        )
        Spacer(Modifier.height(16.dp))
        PrimaryButton(
            text = stringResource(R.string.login_verify),
            busyText = stringResource(R.string.login_verifying),
            busy = ui.busy,
            enabled = code.isNotBlank(),
            onClick = submit,
        )
        Spacer(Modifier.height(8.dp))
        SecondaryButton(stringResource(R.string.back), enabled = !ui.busy, onClick = onCancel)
    }
}

@Preview
@Composable
private fun LoginPreview() {
    SeekCloudTheme {
        LoginScreen(SavedServer("p", "https://seekcloud.example.com"), true, LoginUi(), {}, {}, {}, {}, {}, {})
    }
}

@Preview
@Composable
private fun SetupPreview() {
    SeekCloudTheme {
        LoginScreen(
            SavedServer("p", "https://seekcloud.example.com"), false, LoginUi(needsSetup = true),
            {}, {}, {}, {}, {}, {},
        )
    }
}
