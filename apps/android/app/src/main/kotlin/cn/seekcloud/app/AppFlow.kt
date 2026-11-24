package cn.seekcloud.app

import cn.seekcloud.app.auth.Auth
import cn.seekcloud.app.auth.LoginResult
import cn.seekcloud.app.auth.TokenStore
import cn.seekcloud.app.connect.Problem
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ProbeResult
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerStore
import cn.seekcloud.app.net.ServerTrust
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.withContext

/** App 现在显示哪一页（#205）。 */
sealed interface Screen {
    /** 刚打开，正在认主站、核对登录状态。 */
    data object Starting : Screen

    /**
     * "连接服务器"页。[editing] 是给已经存着的一台改地址（出错页的"修改地址"，或者证书换了、主站让改用 https，
     * 要重新确认），[autoConnect] 时一打开就连。
     */
    data class Connect(val editing: SavedServer? = null, val autoConnect: Boolean = false) : Screen

    /** 登录页。[signedOut] 是这台设备被退出了（令牌被吊销）才回到这里的。 */
    data class Login(val server: SavedServer, val signedOut: Boolean = false) : Screen

    /** 登录以后的首页（会话列表是 #124，现在先放登录状态和退出、换服务器）。 */
    data class Home(val server: SavedServer, val nickname: String?) : Screen

    /** 主站连不上：重试、改地址、换服务器。 */
    data class Offline(val server: SavedServer, val problem: Problem) : Screen

    /** 主站要求更高的 App 版本。 */
    data class UpdateRequired(val server: SavedServer, val required: String) : Screen

    /** 保存的服务器列表。 */
    data object Servers : Screen
}

/** 和一台主站说话要用的：认主站、登录相关的接口。测试里换成假的。 */
interface ServerApis {
    suspend fun probe(address: ServerAddress, trust: ServerTrust): ProbeResult
    fun auth(server: SavedServer, token: String?): Auth
}

/** 登录第一步之后：进了首页，或者要输两步验证的验证码。 */
sealed interface LoginStep {
    data class Done(val screen: Screen) : LoginStep
    class SecondFactor(val pendingToken: String) : LoginStep {
        override fun toString() = "SecondFactor(***)"
    }
}

/**
 * App 在各页之间怎么走（#205），不碰界面，方便测：
 * - 打开时认一认现在用的那台：连不上去出错页，证书换了、要升 https 回"连接服务器"页重新确认，版本太低提示更新；
 * - 有令牌就问 `/api/me`：认就进首页，401（令牌被吊销了）删掉令牌回登录页并说明"此设备已退出登录"；
 * - 令牌只存在 [TokenStore] 里（加密），按主站的编号存，改地址不丢。
 */
class AppFlow(
    private val servers: ServerStore,
    private val tokens: TokenStore,
    private val apis: ServerApis,
    private val deviceName: String,
    /** 网络请求在哪跑：App 里是 Dispatchers.IO，测试里就地跑。 */
    private val io: CoroutineContext = EmptyCoroutineContext,
) {
    /** App 打开时去哪一页。 */
    suspend fun start(): Screen = servers.current()?.let { open(it) } ?: Screen.Connect()

    /** 打开一台主站。 */
    suspend fun open(server: SavedServer): Screen {
        val address = server.address ?: return Screen.Connect(editing = server)
        val probe = guard { apis.probe(address, server.trust) } ?: ProbeResult.Unreachable
        return when (probe) {
            is ProbeResult.Connected -> afterConnect(server)
            is ProbeResult.AppTooOld -> Screen.UpdateRequired(server, probe.required)
            // 证书换了、要改用 https、明文的放行没了：回"连接服务器"页，按原来的流程重新确认
            ProbeResult.NeedsCleartextConsent, is ProbeResult.UseHttps, is ProbeResult.UntrustedCertificate ->
                Screen.Connect(editing = server, autoConnect = true)
            ProbeResult.TlsFailure -> Screen.Offline(server, Problem.TlsFailure)
            ProbeResult.Unreachable -> Screen.Offline(server, Problem.Unreachable)
            ProbeResult.NotSeekCloud -> Screen.Offline(server, Problem.NotSeekCloud)
            ProbeResult.Unavailable -> Screen.Offline(server, Problem.Unavailable)
        }
    }

    /** 认出是 SeekCloud 以后：看登录状态。 */
    suspend fun afterConnect(server: SavedServer): Screen {
        val token = tokens.get(server.id) ?: return Screen.Login(server)
        return try {
            val me = withContext(io) { apis.auth(server, token).me() }
            Screen.Home(server, me.nickname)
        } catch (e: ApiException) {
            if (e.status == 401) signedOut(server) else Screen.Offline(server, Problem.Unavailable)
        } catch (e: CancellationException) {
            throw e
        } catch (_: IOException) {
            Screen.Offline(server, Problem.Unreachable)
        }
    }

    /** 主站说这台设备没登录（令牌被吊销、过期）：删掉令牌，回登录页。 */
    fun signedOut(server: SavedServer): Screen {
        tokens.remove(server.id)
        return Screen.Login(server, signedOut = true)
    }

    /** 登录第一步：输密码。出错时抛 [ApiException] 或 IOException，登录页显示。 */
    suspend fun login(server: SavedServer, password: String): LoginStep =
        finish(server, withContext(io) { apis.auth(server, null).login(password, deviceName) })

    /** 登录第二步：两步验证的验证码或恢复码。 */
    suspend fun verify(server: SavedServer, pendingToken: String, code: String): LoginStep =
        finish(server, withContext(io) { apis.auth(server, null).verify(pendingToken, code) })

    private suspend fun finish(server: SavedServer, result: LoginResult): LoginStep = when (result) {
        is LoginResult.SecondFactor -> LoginStep.SecondFactor(result.pendingToken)
        is LoginResult.Token -> {
            tokens.put(server.id, result.token)
            LoginStep.Done(afterConnect(server))
        }
    }

    /** 主站是不是还没设置管理员密码（只能在网页上做首次设置）。连不上时当作不是，登录时再报。 */
    suspend fun needsSetup(server: SavedServer): Boolean = try {
        withContext(io) { apis.auth(server, null).me() }
        false
    } catch (e: ApiException) {
        e.error?.code == "setup_required"
    } catch (e: CancellationException) {
        throw e
    } catch (_: IOException) {
        false
    }

    /** 退出登录：先在主站上退出这台设备（连不上也不要紧），再删掉令牌。 */
    suspend fun logout(server: SavedServer): Screen {
        revoke(server)
        return Screen.Login(server)
    }

    /** 换到另一台。 */
    suspend fun switchTo(server: SavedServer): Screen {
        servers.select(server.id)
        return open(server)
    }

    /** 删掉一台：在主站上退出、删掉令牌；删的是现在用的就换到剩下的第一台，一台都没有了回"连接服务器"页。 */
    suspend fun remove(server: SavedServer): Screen? {
        val wasCurrent = servers.current()?.id == server.id
        revoke(server)
        servers.remove(server.id)
        if (!wasCurrent) return null
        return servers.current()?.let { open(it) } ?: Screen.Connect()
    }

    /** 连上了（新加的一台，或者改了地址的一台）。改地址时并掉的那一台的令牌删掉。 */
    suspend fun connected(server: SavedServer, merged: String?): Screen {
        merged?.let { tokens.remove(it) }
        return afterConnect(server)
    }

    fun hasToken(server: SavedServer): Boolean = tokens.get(server.id) != null

    private suspend fun revoke(server: SavedServer) {
        val token = tokens.get(server.id)
        tokens.remove(server.id)
        if (token != null) guard { withContext(io) { apis.auth(server, token).logout() } }
    }

    /** 网络层没料到的错误不让 App 崩掉。 */
    private suspend fun <T> guard(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}
