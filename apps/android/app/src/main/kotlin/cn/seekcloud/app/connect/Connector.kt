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
    data class AskCleartext(val address: ServerAddress, val trust: ServerTrust) : ConnectState

    /** 证书系统不信任：给管理员看指纹，问是否信任这一张。[changed] 是以前确认过别的证书。 */
    data class AskCertificate(
        val address: ServerAddress,
        val trust: ServerTrust,
        val fingerprint: String,
        val changed: Boolean,
    ) : ConnectState

    /** 连上了，已经记下这台主站。 */
    data class Connected(val address: ServerAddress, val server: SavedServer) : ConnectState
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
 */
class Connector(
    private val store: ServerStore,
    private val probe: suspend (ServerAddress, ServerTrust) -> ProbeResult,
) {
    suspend fun connect(input: String): ConnectState {
        val address = ServerAddress.parse(input) ?: return ConnectState.Failed(Problem.Invalid)
        return attempt(address)
    }

    suspend fun allowCleartext(ask: ConnectState.AskCleartext): ConnectState =
        attempt(ask.address, ask.trust.copy(allowCleartext = true))

    suspend fun trustCertificate(ask: ConnectState.AskCertificate): ConnectState =
        attempt(ask.address, ask.trust.copy(pinnedCertificate = ask.fingerprint))

    private suspend fun attempt(
        address: ServerAddress,
        trust: ServerTrust = store.find(address)?.trust ?: ServerTrust(),
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
            is ProbeResult.Connected -> {
                val server = SavedServer(address.origin, trust.allowCleartext, trust.pinnedCertificate)
                store.save(server)
                ConnectState.Connected(address, server)
            }
            ProbeResult.NeedsCleartextConsent -> ConnectState.AskCleartext(address, trust)
            // https 的地址不会再让升级，不会转圈
            is ProbeResult.UseHttps -> attempt(result.address)
            is ProbeResult.UntrustedCertificate ->
                ConnectState.AskCertificate(address, trust, result.fingerprint, result.changed)
            ProbeResult.TlsFailure -> ConnectState.Failed(Problem.TlsFailure)
            ProbeResult.Unreachable -> ConnectState.Failed(Problem.Unreachable)
            ProbeResult.NotSeekCloud -> ConnectState.Failed(Problem.NotSeekCloud)
            ProbeResult.Unavailable -> ConnectState.Failed(Problem.Unavailable)
            is ProbeResult.AppTooOld -> ConnectState.Failed(Problem.AppTooOld(result.required))
        }
    }
}
