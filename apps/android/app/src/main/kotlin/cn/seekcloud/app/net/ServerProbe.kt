package cn.seekcloud.app.net

import java.io.IOException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Request

/** 点"连接"以后的结果（#204）：每一种失败，"连接服务器"页给出不同的说明和下一步。 */
sealed interface ProbeResult {
    /** 是一台 SeekCloud 主站，可以去登录了。 */
    data class Connected(val minAppVersion: String?) : ProbeResult

    /** 地址是 http，管理员还没确认"连接未加密"：还没有发出任何请求。 */
    data object NeedsCleartextConsent : ProbeResult

    /**
     * 地址是 http，主站让跳到同一台主机的 https（配好域名和证书以后 Caddy 就这样）：改连 [address]。
     * 只认同一台主机、从 http 升到 https 的跳转，别的跳转一律不跟。
     */
    data class UseHttps(val address: ServerAddress) : ProbeResult

    /**
     * 主站的证书系统不信任（自签的，或者链不完整）。把证书的指纹给管理员看，确认以后钉住这一张。
     * [changed] 为 true 时，以前钉住过别的证书：证书换了，要格外小心。
     */
    data class UntrustedCertificate(
        val certificate: X509Certificate,
        val fingerprint: String,
        val changed: Boolean,
    ) : ProbeResult

    /** 证书以外的 TLS 问题（协议、加密套件对不上这类），没法放行。 */
    data object TlsFailure : ProbeResult

    /** 连不上：域名解析不了、连接被拒绝、超时。 */
    data object Unreachable : ProbeResult

    /** 连上了，但对方不是 SeekCloud（不是 JSON、`product` 不对、没有这个接口）。 */
    data object NotSeekCloud : ProbeResult

    /** 是 SeekCloud，但暂时不可用（比如数据库连不上，健康检查回 503）。 */
    data object Unavailable : ProbeResult

    /** 主站要求的 App 版本比这个高：要先更新 App。 */
    data class AppTooOld(val required: String) : ProbeResult
}

@Serializable
private data class HealthBody(
    val product: String? = null,
    val status: String? = null,
    val minAppVersion: String? = null,
)

private val json = Json { ignoreUnknownKeys = true }

/**
 * 认一认这台主站（#204）：请求 `/api/health`，返回里 `product` 是 `seekcloud` 才算。
 * 只读健康检查里用得到的几项，别的不管：主站加了新字段也不影响连接。
 */
fun probeServer(
    address: ServerAddress,
    trust: ServerTrust,
    appVersion: String,
    userAgent: String,
    clientFor: (ServerAddress, ServerTrust) -> ServerClient = { a, t -> serverClient(a, t, userAgent) },
): ProbeResult {
    if (!address.secure && !trust.allowCleartext) return ProbeResult.NeedsCleartextConsent
    val client = clientFor(address, trust)
    val request = Request.Builder().url(address.url("/api/health")).get().build()
    return try {
        client.http.newCall(request).execute().use { response ->
            if (!address.secure && response.isRedirect) {
                val target = response.header("Location")?.let { request.url.resolve(it) }
                if (target != null && target.isHttps && target.host == address.host) {
                    return ProbeResult.UseHttps(ServerAddress(true, target.host, target.port.takeIf { it != 443 }))
                }
            }
            val body = response.body.string()
            val health = runCatching { json.decodeFromString<HealthBody>(body) }.getOrNull()
            when {
                health?.product != "seekcloud" -> ProbeResult.NotSeekCloud
                !response.isSuccessful -> ProbeResult.Unavailable
                isAppTooOld(appVersion, health.minAppVersion) ->
                    ProbeResult.AppTooOld(health.minAppVersion!!)
                else -> ProbeResult.Connected(health.minAppVersion)
            }
        }
    } catch (e: IOException) {
        // 这次连接里有证书被拒过，就按证书的问题说：OkHttp 换一条线路重试时，最后抛出的可能是别的错误
        val rejected = client.trust.rejected
        when {
            rejected != null -> ProbeResult.UntrustedCertificate(
                rejected,
                rejected.sha256Fingerprint(),
                changed = trust.pinnedCertificate != null,
            )
            e is SSLException -> ProbeResult.TlsFailure
            else -> ProbeResult.Unreachable
        }
    }
}

/**
 * App 的版本是不是比主站要求的最低版本低。版本号按点分的数字比（`0.10.0` 比 `0.9.2` 新），
 * `-` 后面的预发布标记不算；读不懂的版本号不拦。
 */
fun isAppTooOld(appVersion: String, minAppVersion: String?): Boolean {
    if (minAppVersion.isNullOrBlank()) return false
    val app = numericParts(appVersion) ?: return false
    val min = numericParts(minAppVersion) ?: return false
    for (i in 0 until maxOf(app.size, min.size)) {
        val a = app.getOrElse(i) { 0 }
        val m = min.getOrElse(i) { 0 }
        if (a != m) return a < m
    }
    return false
}

private fun numericParts(version: String): List<Int>? =
    version.trim().substringBefore('-').split('.').map { it.toIntOrNull() ?: return null }
