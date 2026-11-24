package cn.seekcloud.app.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * 管理员在"连接服务器"页填的主站地址，规整以后的样子（#204）：只有协议、主机和端口。
 * - 去掉前后的空白；没写协议时补 `https://`；只认 http 和 https；
 * - 去掉路径、查询和片段（复制网页地址时常带着 `/s/xxx`）；
 * - 主机名转小写，国际化域名转成 punycode，IPv6 写在方括号里；端口是协议默认的就不写；
 * - 带用户名、密码的地址（`user:pass@host`）不认：容易被用来伪装成别的主机。
 */
data class ServerAddress(val secure: Boolean, val host: String, val port: Int?) {
    /** 主站的根地址，比如 `https://seekcloud.example.com`、`http://192.168.1.5:8080`、`https://[::1]:8443`。 */
    val origin: String
        get() = buildString {
            append(if (secure) "https://" else "http://")
            append(if (':' in host) "[$host]" else host)
            if (port != null) append(":$port")
        }

    /** 这台主站上的某个接口，比如 `url("/api/health")`。 */
    fun url(path: String): HttpUrl = "$origin$path".toHttpUrlOrNull()
        ?: throw IllegalArgumentException("bad path: $path")

    companion object {
        private val SCHEME = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://")

        /** 规整管理员填的地址；不是一个能连的主站地址时返回 null。 */
        fun parse(input: String): ServerAddress? {
            val trimmed = input.trim()
            if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
            val scheme = SCHEME.find(trimmed)?.groupValues?.get(1)?.lowercase()
            if (scheme != null && scheme != "http" && scheme != "https") return null
            val withScheme = if (scheme == null) "https://$trimmed" else trimmed
            val url = withScheme.toHttpUrlOrNull() ?: return null
            if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
            if (url.host.isEmpty()) return null
            val secure = url.isHttps
            val defaultPort = if (secure) 443 else 80
            return ServerAddress(secure, url.host, url.port.takeIf { it != defaultPort })
        }
    }
}
