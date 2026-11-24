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
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import cn.seekcloud.app.AppViewModel
import cn.seekcloud.app.Screen
import cn.seekcloud.app.connect.ConnectRoute
import cn.seekcloud.app.net.PreferencesStore
import cn.seekcloud.app.net.eventStream
import cn.seekcloud.app.sessions.HttpSessionPageApi
import cn.seekcloud.app.sessions.NewSessionApi
import cn.seekcloud.app.sessions.NewSessionViewModel
import cn.seekcloud.app.sessions.SessionListViewModel
import cn.seekcloud.app.sessions.SessionViewModel
import cn.seekcloud.app.sessions.SessionsApi

/** 按 [AppViewModel]（[app]）现在的页面画出来，页面之间淡入淡出。 */
@Composable
fun AppRoot(app: AppViewModel = viewModel()) {
    val screen by app.screen.collectAsStateWithLifecycle()
    val login by app.login.collectAsStateWithLifecycle()
    val retrying by app.retrying.collectAsStateWithLifecycle()

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
                signedIn = current.editing?.let(app::hasToken) ?: false,
                onConnected = app::connected,
                onBack = when {
                    app.canGoBack -> app::goBack
                    app.servers.servers().isNotEmpty() -> app::showServers
                    else -> null
                },
            )
            is Screen.Login -> LoginScreen(
                server = current.server,
                signedOut = current.signedOut,
                ui = login,
                onCheckSetup = { app.checkSetup(current.server) },
                onSignIn = { app.signIn(current.server, it) },
                onVerify = { app.verify(current.server, it) },
                onCancelSecondFactor = app::cancelSecondFactor,
                onEdited = app::clearLoginError,
                onSwitchServer = app::showServers,
            )
            is Screen.Home -> SessionListRoute(
                server = current.server,
                nickname = current.nickname,
                // 每台主站一个，换服务器、改地址以后是新的
                viewModel = viewModel(key = "sessions:${current.server.id}:${current.server.origin}") {
                    SessionListViewModel(app.client(current.server), onSignedOut = { app.signedOut(current.server) })
                },
                newSession = {
                    val context = LocalContext.current
                    viewModel(key = "new-session:${current.server.id}:${current.server.origin}") {
                        NewSessionViewModel(
                            source = NewSessionApi(app.client(current.server)),
                            store = PreferencesStore(context.applicationContext, "new-session"),
                            serverId = current.server.id,
                            onSignedOut = { app.signedOut(current.server) },
                        )
                    }
                },
                sessionPage = { shortId ->
                    viewModel(key = "session:${current.server.id}:${current.server.origin}:$shortId") {
                        val client = app.client(current.server)
                        SessionViewModel(
                            shortId = shortId,
                            api = HttpSessionPageApi(client),
                            actions = SessionsApi(client),
                            stream = { last, onConnected ->
                                eventStream(client.http, client.address.url("/api/sessions/$shortId/events"), last, onConnected = onConnected)
                            },
                            onSignedOut = { app.signedOut(current.server) },
                        )
                    }
                },
                onSwitchServer = app::showServers,
                onSignOut = { app.logout(current.server) },
            )
            is Screen.Offline -> OfflineScreen(
                server = current.server,
                problem = current.problem,
                retrying = retrying,
                onRetry = { app.retry(current.server) },
                onEditAddress = { app.editAddress(current.server) },
                onSwitchServer = app::showServers,
            )
            is Screen.UpdateRequired -> UpdateRequiredScreen(
                server = current.server,
                required = current.required,
                retrying = retrying,
                onRetry = { app.retry(current.server) },
                onSwitchServer = app::showServers,
            )
            Screen.Servers -> ServersScreen(
                servers = app.servers.servers(),
                currentId = app.servers.current()?.id,
                signedIn = app::hasToken,
                onSelect = app::switchTo,
                onAdd = app::addServer,
                onRemove = app::remove,
                onBack = if (app.canGoBack) app::goBack else null,
            )
        }
    }
}
