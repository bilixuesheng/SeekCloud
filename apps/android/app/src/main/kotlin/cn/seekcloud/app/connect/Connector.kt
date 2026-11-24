package cn.seekcloud.app.connect

import cn.seekcloud.app.net.ProbeResult
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.ServerAddress
import cn.seekcloud.app.net.ServerStore
import cn.seekcloud.app.net.ServerTrust
import kotlin.coroutines.cancellation.CancellationException

/** "连接服务器"页现在的样子（#204）。 */
sealed interface ConnectState {
    data object Idle : ConnectState

    data object Connecting : ConnectState

    /** 连不上，[problem] 说是哪一种。 */
    data class Failed(val problem: Problem) : ConnectState

    /** 地址是 http：问管理员是否接受"连接未加密"。 */
    data class AskCleartext(val address: ServerAddress, val trust: ServerTrust, val editing: String? = null) : ConnectState

    /** 证书系统不信任：给管理员看指纹，问是否信任这一张。[changed] 是以前确认过别的证书。 */
    data class AskCertificate(
        val address: ServerAddress,
        val trust: ServerTrust,
        val fingerprint: String,
        val changed: Boolean,
        val editing: String? = null,
    ) : ConnectState

    /**
     * 连上了，已经记下这台主站。改地址时新地址原来存成了另一台，那一台并了进来，[merged] 是它的编号
     * （它的令牌要删掉）。
     */
    data class Connected(val address: ServerAddress, val server: SavedServer, val merged: String? = null) : ConnectState
}

/** 连不上的原因，每一种在页面上有自己的说明。 */
sealed interface Problem {
    data object Invalid : Problem
    data object Unreachable : Problem
    data object NotSeekCloud : Problem
    data object Unavailable : Problem
    data object TlsFailure : Problem
    data class AppTooOld(val required: String) : Problem
}

/**
 * 连接的流程（#204）：规整地址 → 用以前对这个地址的放行去认一认主站 → 要管理员确认的就问 → 连上了记下来。
 * 管理员的每一次确认只放行这一次问到的东西（这个地址的明文、这一张证书），确认后重新连一次。
 * [connect] 的 editing 是在出错页里给已经存着的一台改地址（#205）：连上以后还是那一台，编号和登录状态不变。
 */
class Connector(
    private val store: ServerStore,
    private val probe: suspend (ServerAddress, ServerTrust) -> ProbeResult,
) {
    suspend fun connect(input: String, editing: String? = null): ConnectState {
        val address = ServerAddress.parse(input) ?: return ConnectState.Failed(Problem.Invalid)
        return attempt(address, editing)
    }

    suspend fun allowCleartext(ask: ConnectState.AskCleartext): ConnectState =
        attempt(ask.address, ask.editing, ask.trust.copy(allowCleartext = true))

    suspend fun trustCertificate(ask: ConnectState.AskCertificate): ConnectState =
        attempt(ask.address, ask.editing, ask.trust.copy(pinnedCertificate = ask.fingerprint))

    /** 以前对这个地址的放行：改地址时只看这一台自己的（地址没变才算），别的看存着的同一个地址。 */
    private fun knownTrust(address: ServerAddress, editing: String?): ServerTrust {
        val saved = if (editing != null) store.get(editing)?.takeIf { it.origin == address.origin } else store.find(address)
        return saved?.trust ?: ServerTrust()
    }

    private suspend fun attempt(
        address: ServerAddress,
        editing: String?,
        trust: ServerTrust = knownTrust(address, editing),
    ): ConnectState {
        val result = try {
            probe(address, trust)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // 网络层没料到的错误也只当作连不上，不让 App 崩掉
            ProbeResult.Unreachable
        }
        return when (result) {
            is ProbeResult.Connected -> if (editing != null) {
                val (server, merged) = store.changeAddress(editing, address, trust)
                ConnectState.Connected(address, server, merged)
            } else {
                ConnectState.Connected(address, store.save(address, trust))
            }
            ProbeResult.NeedsCleartextConsent -> ConnectState.AskCleartext(address, trust, editing)
            // https 的地址不会再让升级，不会转圈
            is ProbeResult.UseHttps -> attempt(result.address, editing)
            is ProbeResult.UntrustedCertificate ->
                ConnectState.AskCertificate(address, trust, result.fingerprint, result.changed, editing)
            ProbeResult.TlsFailure -> ConnectState.Failed(Problem.TlsFailure)
            ProbeResult.Unreachable -> ConnectState.Failed(Problem.Unreachable)
            ProbeResult.NotSeekCloud -> ConnectState.Failed(Problem.NotSeekCloud)
            ProbeResult.Unavailable -> ConnectState.Failed(Problem.Unavailable)
            is ProbeResult.AppTooOld -> ConnectState.Failed(Problem.AppTooOld(result.required))
        }
    }
}
