package cn.seekcloud.app.net

import android.content.Context
import androidx.core.content.edit
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 连上过的一台主站：地址和管理员对它放行过什么（#204）。[id] 是 App 给它起的编号，地址换了也不变，
 * 设备令牌按它存（#205：主站换了域名，在出错页里改地址，登录状态跟着保留）。
 * 放行只对这一个地址（协议、主机、端口都一样）有效，改地址时按新地址重新问。
 */
@Serializable
data class SavedServer(
    val id: String,
    val origin: String,
    val allowCleartext: Boolean = false,
    val pinnedCertificate: String? = null,
) {
    val trust: ServerTrust
        get() = ServerTrust(allowCleartext, pinnedCertificate)

    val address: ServerAddress?
        get() = ServerAddress.parse(origin)
}

/** 存东西的地方：App 里是 SharedPreferences，测试里是内存。 */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

/** App 自己的 SharedPreferences（不进备份，见 AndroidManifest.xml）。 */
class PreferencesStore(context: Context, name: String = "servers") : KeyValueStore {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String) = prefs.edit { putString(key, value) }
    override fun remove(key: String) = prefs.edit { remove(key) }
}

@Serializable
private data class Servers(val servers: List<SavedServer> = emptyList(), val current: String? = null)

/**
 * 保存的主站（#204、#205）：连上一台就记下来，并当作现在用的这台；可以存几台，切换、删除、改地址。
 * 存的内容读不懂（比如被别的版本写坏了）时当作什么都没存，重新连就是。
 */
class ServerStore(private val store: KeyValueStore, private val newId: () -> String = { UUID.randomUUID().toString() }) {
    private fun read(): Servers =
        store.get(KEY)?.let { runCatching { json.decodeFromString<Servers>(it) }.getOrNull() } ?: Servers()

    private fun write(servers: Servers) = store.put(KEY, json.encodeToString(servers))

    fun servers(): List<SavedServer> = read().servers

    /** 现在用的这台。 */
    fun current(): SavedServer? = read().let { s -> s.servers.firstOrNull { it.id == s.current } }

    fun get(id: String): SavedServer? = read().servers.firstOrNull { it.id == id }

    fun find(address: ServerAddress): SavedServer? = read().servers.firstOrNull { it.origin == address.origin }

    /** 连上了一个地址：已经存过就更新放行设置，没存过就新加一台；都当作现在用的。 */
    fun save(address: ServerAddress, trust: ServerTrust): SavedServer {
        val s = read()
        val existing = s.servers.firstOrNull { it.origin == address.origin }
        val server = SavedServer(existing?.id ?: newId(), address.origin, trust.allowCleartext, trust.pinnedCertificate)
        write(Servers(s.servers.map { if (it.id == server.id) server else it }.let { if (existing == null) it + server else it }, server.id))
        return server
    }

    /**
     * 给 [id] 这台换个地址（主站换了域名）。新地址已经存成了另一台时，那一台并进来（编号和登录状态用这一台的），
     * 返回被并掉的那台的编号，好删掉它的令牌。
     */
    fun changeAddress(id: String, address: ServerAddress, trust: ServerTrust): Pair<SavedServer, String?> {
        val s = read()
        val duplicate = s.servers.firstOrNull { it.origin == address.origin && it.id != id }
        val server = SavedServer(id, address.origin, trust.allowCleartext, trust.pinnedCertificate)
        val servers = s.servers.filter { it.id != duplicate?.id }.map { if (it.id == id) server else it }
        write(Servers(if (servers.any { it.id == id }) servers else servers + server, id))
        return server to duplicate?.id
    }

    fun select(id: String) {
        val s = read()
        if (s.servers.any { it.id == id }) write(s.copy(current = id))
    }

    /** 删掉一台；删的是现在用的这台时，现在用的换成剩下的第一台（没有了就是空的）。 */
    fun remove(id: String) {
        val s = read()
        val servers = s.servers.filter { it.id != id }
        write(Servers(servers, if (s.current == id) servers.firstOrNull()?.id else s.current))
    }

    private companion object {
        const val KEY = "servers"
        val json = Json { ignoreUnknownKeys = true }
    }
}
