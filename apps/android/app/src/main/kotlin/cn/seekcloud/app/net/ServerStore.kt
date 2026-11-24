package cn.seekcloud.app.net

import android.content.Context
import androidx.core.content.edit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 连上过的一台主站（#204）：地址和管理员对它放行过什么。设备令牌不放这里，放 App 的加密存储（#205）。
 * 放行只对这一个地址（协议、主机、端口都一样）有效。
 */
@Serializable
data class SavedServer(
    val origin: String,
    val allowCleartext: Boolean = false,
    val pinnedCertificate: String? = null,
) {
    val trust: ServerTrust
        get() = ServerTrust(allowCleartext, pinnedCertificate)
}

/** 存东西的地方：App 里是 SharedPreferences，测试里是内存。 */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
}

/** App 自己的 SharedPreferences（不进备份，见 AndroidManifest.xml）。 */
class PreferencesStore(context: Context, name: String = "servers") : KeyValueStore {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String) = prefs.edit { putString(key, value) }
}

@Serializable
private data class Servers(val servers: List<SavedServer> = emptyList(), val current: String? = null)

/**
 * 保存的主站（#204）：连上一台就记下来，并当作现在用的这台。服务器列表、切换和删除是 #205。
 * 存的内容读不懂（比如被别的版本写坏了）时当作什么都没存，重新连就是。
 */
class ServerStore(private val store: KeyValueStore) {
    private fun read(): Servers =
        store.get(KEY)?.let { runCatching { json.decodeFromString<Servers>(it) }.getOrNull() } ?: Servers()

    fun servers(): List<SavedServer> = read().servers

    /** 现在用的这台。 */
    fun current(): SavedServer? = read().let { s -> s.servers.firstOrNull { it.origin == s.current } }

    fun find(address: ServerAddress): SavedServer? = read().servers.firstOrNull { it.origin == address.origin }

    /** 记下这台（同一个地址的换成新的），并把它当作现在用的。 */
    fun save(server: SavedServer) {
        val others = read().servers.filter { it.origin != server.origin }
        store.put(KEY, json.encodeToString(Servers(others + server, server.origin)))
    }

    private companion object {
        const val KEY = "servers"
        val json = Json { ignoreUnknownKeys = true }
    }
}
