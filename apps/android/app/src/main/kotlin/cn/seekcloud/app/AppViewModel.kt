package cn.seekcloud.app

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import cn.seekcloud.app.auth.AuthApi
import cn.seekcloud.app.auth.KeystoreCipher
import cn.seekcloud.app.auth.TokenStore
import cn.seekcloud.app.connect.ConnectState
import cn.seekcloud.app.net.PreferencesStore
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerStore
import cn.seekcloud.app.net.ServerTrust
import cn.seekcloud.app.net.probeServer
import cn.seekcloud.app.net.serverClient
import cn.seekcloud.app.net.userAgent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/** 登录页的样子：在做什么、出了什么错、两步验证的中间令牌、主站是不是还没设置密码。 */
data class LoginUi(
    val busy: Boolean = false,
    val failure: Throwable? = null,
    val pendingToken: String? = null,
    val needsSetup: Boolean = false,
) {
    override fun toString() = "LoginUi(busy=$busy, failure=${failure?.javaClass?.simpleName}, twoFactor=${pendingToken != null})"
}

/**
 * 整个 App 的页面和登录状态（#205），旋转屏幕、分屏、深色模式切换都不丢。
 * 流程在 [AppFlow] 里（有单元测试），这里只把它接到界面上、管"返回"回到哪一页。
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {
    val servers = ServerStore(PreferencesStore(application))
    private val tokens = TokenStore(PreferencesStore(application, "tokens"), KeystoreCipher())
    private val version = BuildConfig.VERSION_NAME
    private val agent = userAgent(version, Build.VERSION.SDK_INT)

    private val apis = object : ServerApis {
        override suspend fun probe(address: ServerAddress, trust: ServerTrust) =
            withContext(Dispatchers.IO) { probeServer(address, trust, version, agent) }

        override fun auth(server: SavedServer, token: String?) =
            AuthApi(serverClient(requireNotNull(server.address), server.trust, agent, token = { token }))
    }

    private val flow = AppFlow(servers, tokens, apis, deviceName(), Dispatchers.IO)

    private val _screen = MutableStateFlow<Screen>(Screen.Starting)
    val screen: StateFlow<Screen> = _screen.asStateFlow()

    private val _login = MutableStateFlow(LoginUi())
    val login: StateFlow<LoginUi> = _login.asStateFlow()

    /** 出错页、要更新页上"重试"正在跑。 */
    private val _retrying = MutableStateFlow(false)
    val retrying: StateFlow<Boolean> = _retrying.asStateFlow()

    /** 服务器列表、添加服务器、改地址这几页按"返回"回到哪里。 */
    private var back: Screen? = null
    private var job: Job? = null

    init {
        go { flow.start() }
    }

    val canGoBack: Boolean
        get() = back != null

    fun goBack() {
        back?.let { show(it) }
    }

    fun hasToken(server: SavedServer) = flow.hasToken(server)

    fun showServers() {
        back = _screen.value.takeIf { it !is Screen.Servers }
        _screen.value = Screen.Servers
    }

    fun addServer() {
        back = _screen.value
        _screen.value = Screen.Connect()
    }

    fun editAddress(server: SavedServer) {
        back = _screen.value
        _screen.value = Screen.Connect(editing = server)
    }

    fun connected(state: ConnectState.Connected) = go { flow.connected(state.server, state.merged) }

    fun retry(server: SavedServer) {
        _retrying.value = true
        go { flow.open(server) }
    }

    fun switchTo(server: SavedServer) = go { flow.switchTo(server) }

    fun remove(server: SavedServer) {
        viewModelScope.launch {
            val next = flow.remove(server)
            if (next != null) show(next) else _screen.value = Screen.Servers
        }
    }

    fun logout(server: SavedServer) = go { flow.logout(server) }

    /** 别处的请求说这台设备没登录了（令牌被吊销）。 */
    fun signedOut(server: SavedServer) = show(flow.signedOut(server))

    fun signIn(server: SavedServer, password: String) = loginStep { flow.login(server, password) }

    fun verify(server: SavedServer, code: String) {
        val pending = _login.value.pendingToken ?: return
        loginStep { flow.verify(server, pending, code) }
    }

    /** 两步验证那一步按"返回"：回到输密码。 */
    fun cancelSecondFactor() {
        _login.value = LoginUi()
    }

    fun clearLoginError() {
        if (_login.value.failure != null) _login.value = _login.value.copy(failure = null)
    }

    /** 进了登录页：在后台看看主站是不是还没设置密码。不挡着输密码。 */
    fun checkSetup(server: SavedServer) {
        viewModelScope.launch {
            val needsSetup = flow.needsSetup(server)
            _login.value = _login.value.copy(needsSetup = needsSetup)
        }
    }

    private fun loginStep(block: suspend () -> LoginStep) {
        if (_login.value.busy) return
        _login.value = _login.value.copy(busy = true, failure = null)
        viewModelScope.launch {
            try {
                when (val step = block()) {
                    is LoginStep.SecondFactor -> _login.value = LoginUi(pendingToken = step.pendingToken)
                    is LoginStep.Done -> show(step.screen)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _login.value = _login.value.copy(busy = false, failure = e)
            }
        }
    }

    private fun go(block: suspend () -> Screen) {
        job?.cancel()
        job = viewModelScope.launch { show(block()) }
    }

    private fun show(screen: Screen) {
        if (screen !is Screen.Servers && screen !is Screen.Connect) back = null
        if (screen is Screen.Login) _login.value = LoginUi()
        _retrying.value = false
        _screen.value = screen
    }

    private fun deviceName(): String {
        val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.orEmpty()
        return when {
            model.isBlank() -> maker.ifBlank { "Android" }
            model.startsWith(maker, ignoreCase = true) -> model
            else -> "$maker $model"
        }.take(100)
    }
}
