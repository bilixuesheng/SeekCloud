package cn.seekcloud.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.seekcloud.app.AppViewModel
import cn.seekcloud.app.Screen
import cn.seekcloud.app.connect.ConnectRoute

/** 按 [AppViewModel] 现在的页面画出来，页面之间淡入淡出。 */
@Composable
fun AppRoot(viewModel: AppViewModel = viewModel()) {
    val screen by viewModel.screen.collectAsStateWithLifecycle()
    val login by viewModel.login.collectAsStateWithLifecycle()
    val retrying by viewModel.retrying.collectAsStateWithLifecycle()

    AnimatedContent(
        targetState = screen,
        contentKey = { it::class },
        transitionSpec = { fadeIn() togetherWith fadeOut() },
        label = "screen",
    ) { current ->
        when (current) {
            Screen.Starting -> Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Box(Modifier.fillMaxSize())
            }
            is Screen.Connect -> ConnectRoute(
                editing = current.editing,
                autoConnect = current.autoConnect,
                signedIn = current.editing?.let(viewModel::hasToken) ?: false,
                onConnected = viewModel::connected,
                onBack = when {
                    viewModel.canGoBack -> viewModel::goBack
                    viewModel.servers.servers().isNotEmpty() -> viewModel::showServers
                    else -> null
                },
            )
            is Screen.Login -> LoginScreen(
                server = current.server,
                signedOut = current.signedOut,
                ui = login,
                onCheckSetup = { viewModel.checkSetup(current.server) },
                onSignIn = { viewModel.signIn(current.server, it) },
                onVerify = { viewModel.verify(current.server, it) },
                onCancelSecondFactor = viewModel::cancelSecondFactor,
                onEdited = viewModel::clearLoginError,
                onSwitchServer = viewModel::showServers,
            )
            is Screen.Home -> HomeScreen(
                server = current.server,
                nickname = current.nickname,
                onSwitchServer = viewModel::showServers,
                onSignOut = { viewModel.logout(current.server) },
            )
            is Screen.Offline -> OfflineScreen(
                server = current.server,
                problem = current.problem,
                retrying = retrying,
                onRetry = { viewModel.retry(current.server) },
                onEditAddress = { viewModel.editAddress(current.server) },
                onSwitchServer = viewModel::showServers,
            )
            is Screen.UpdateRequired -> UpdateRequiredScreen(
                server = current.server,
                required = current.required,
                retrying = retrying,
                onRetry = { viewModel.retry(current.server) },
                onSwitchServer = viewModel::showServers,
            )
            Screen.Servers -> ServersScreen(
                servers = viewModel.servers.servers(),
                currentId = viewModel.servers.current()?.id,
                signedIn = viewModel::hasToken,
                onSelect = viewModel::switchTo,
                onAdd = viewModel::addServer,
                onRemove = viewModel::remove,
                onBack = if (viewModel.canGoBack) viewModel::goBack else null,
            )
        }
    }
}
