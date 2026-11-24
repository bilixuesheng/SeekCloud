package cn.seekcloud.app.net

import android.annotation.SuppressLint
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.internal.tls.OkHostnameVerifier

/**
 * 管理员对这台主站放行过什么（#204，安全要求照 #123）：
 * - [allowCleartext]：地址是 http 时，管理员确认过"连接未加密"；
 * - [pinnedCertificate]：主站用的是系统不信任的证书（自签）时，管理员确认过的那一张证书的 SHA-256 指纹。
 *   只对这台主站、这一张证书放行；证书换了就不认，要重新问。
 */
data class ServerTrust(val allowCleartext: Boolean = false, val pinnedCertificate: String? = null)

/** 证书的 SHA-256 指纹，大写十六进制、两位一组用冒号隔开（和浏览器、openssl 显示的一样）。 */
fun X509Certificate.sha256Fingerprint(): String =
    MessageDigest.getInstance("SHA-256").digest(encoded).joinToString(":") { "%02X".format(it) }

/**
 * 先按系统信任的证书核对；不过时，证书链的第一张（主站自己的证书）就是管理员钉住的那张才放行。
 * 不放行时把那张证书记在 [rejected]，好让"连接服务器"页把它的指纹给管理员看。
 * lint 提醒自己实现 X509TrustManager 容易出错：这里不放宽系统的核对，只多认管理员按指纹确认过的那一张（有单元测试）。
 */
@SuppressLint("CustomX509TrustManager")
class PinningTrustManager(
    private val system: X509TrustManager,
    private val pinned: String?,
) : X509TrustManager {
    @Volatile
    var rejected: X509Certificate? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
        try {
            system.checkServerTrusted(chain, authType)
        } catch (e: CertificateException) {
            val leaf = chain.firstOrNull()
            if (leaf != null && pinned != null && leaf.sha256Fingerprint() == pinned) return
            rejected = leaf
            throw e
        }
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) =
        system.checkClientTrusted(chain, authType)

    override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers

    companion object {
        /** 系统信任的证书（安卓上是系统和用户装的 CA，按 network_security_config.xml 只认系统的）。 */
        fun systemTrustManager(): X509TrustManager {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            factory.init(null as KeyStore?)
            return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
        }
    }
}

/**
 * 主机名核对：照常核对；钉住的证书是管理员为这台主站确认过的，自签证书常常不写这个主机名（比如用 IP 访问），
 * 所以对方给的正是钉住的那张时也放行。
 */
private class PinnedHostnameVerifier(private val pinned: String?) : HostnameVerifier {
    override fun verify(hostname: String, session: SSLSession): Boolean {
        if (OkHostnameVerifier.verify(hostname, session)) return true
        val leaf = runCatching { session.peerCertificates.firstOrNull() as? X509Certificate }.getOrNull()
        return pinned != null && leaf?.sha256Fingerprint() == pinned
    }
}

/** 连一台主站用的 HTTP 客户端和它的证书核对（拿得到被拒的证书）。 */
class ServerClient(val address: ServerAddress, val http: OkHttpClient, val trust: PinningTrustManager)

/**
 * 为这台主站建一个 HTTP 客户端：
 * - 地址是 http 而管理员没确认过时，只允许 TLS（OkHttp 会直接拒绝明文的请求）；
 * - 证书先按系统信任的核对，再认管理员钉住的那张；
 * - 每个请求带上 App 的 User-Agent；登录以后带上设备令牌（[token] 给出，`Authorization: Bearer`，#177）。
 *   客户端只连这一台主站、不跟跳转，令牌不会被带到别处。
 */
fun serverClient(
    address: ServerAddress,
    trust: ServerTrust,
    userAgent: String,
    token: () -> String? = { null },
    system: X509TrustManager = PinningTrustManager.systemTrustManager(),
): ServerClient {
    val trustManager = PinningTrustManager(system, trust.pinnedCertificate)
    val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }
    val specs = if (!address.secure && trust.allowCleartext) {
        listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT)
    } else {
        listOf(ConnectionSpec.MODERN_TLS)
    }
    val http = OkHttpClient.Builder()
        .connectionSpecs(specs)
        .sslSocketFactory(tls.socketFactory, trustManager)
        .hostnameVerifier(PinnedHostnameVerifier(trust.pinnedCertificate))
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        // 只连管理员填的那台主站：不跟着跳转去别的地方
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor { chain ->
            val request = chain.request().newBuilder().header("User-Agent", userAgent)
            token()?.let { request.header("Authorization", "Bearer $it") }
            chain.proceed(request.build())
        }
        .build()
    return ServerClient(address, http, trustManager)
}
