package cn.seekcloud.app.settings

import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ServerClient
import cn.seekcloud.app.net.toApiException
import cn.seekcloud.app.sessions.ModelList
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 主站的全站设置（#181），用的是网页设置窗口一样的接口（`/api/settings/...`）。
 * 读：主站比 App 旧、没有这个接口（404）时返回 null，那一项不显示。出错抛 [ApiException]，连不上抛 IOException；
 * 设置规则不让改时写会抛 403 `setting_locked`。
 */
interface SiteSettingsApi {
    fun defaultEffort(): String?
    fun setDefaultEffort(effort: String)
    fun hostOfflineGrace(): Int?
    fun setHostOfflineGrace(seconds: Int)

    /** 能用的模型（默认思考强度只列出它们支持的几档，照网页）。 */
    fun models(): ModelList
}

class HttpSiteSettings(private val client: ServerClient) : SiteSettingsApi {
    override fun defaultEffort(): String? =
        read(DEFAULT_EFFORT)?.get("effort")?.jsonPrimitive?.content

    override fun setDefaultEffort(effort: String) = write(DEFAULT_EFFORT, "effort" to JsonPrimitive(effort))

    override fun hostOfflineGrace(): Int? =
        read(HOST_OFFLINE_GRACE)?.get("seconds")?.jsonPrimitive?.intOrNull

    override fun setHostOfflineGrace(seconds: Int) = write(HOST_OFFLINE_GRACE, "seconds" to JsonPrimitive(seconds))

    override fun models(): ModelList = decode(send(Request.Builder().url(client.address.url("/api/models")).get().build()) ?: "{}")

    private fun read(path: String): JsonObject? {
        val text = send(Request.Builder().url(client.address.url(path)).get().build()) ?: return null
        return decode<JsonObject>(text).jsonObject
    }

    private fun write(path: String, vararg fields: Pair<String, JsonPrimitive>) {
        val body = buildJsonObject { for ((k, v) in fields) put(k, v) }.toString().toRequestBody(JSON)
        // 写的时候 404 不当成"没有这一项"：读得到、写不了，说明主站出了问题，照常报错
        val request = Request.Builder().url(client.address.url(path)).put(body).build()
        client.http.newCall(request).execute().use { if (!it.isSuccessful) throw it.toApiException() }
    }

    /** 404 返回 null（主站没有这个接口），别的错误抛出。 */
    private fun send(request: Request): String? = client.http.newCall(request).execute().use { response ->
        if (response.code == 404) return null
        if (!response.isSuccessful) throw response.toApiException()
        response.body.string()
    }

    private inline fun <reified T> decode(text: String): T = try {
        json.decodeFromString<T>(text)
    } catch (_: SerializationException) {
        throw ApiException(200, null)
    } catch (_: IllegalArgumentException) {
        throw ApiException(200, null)
    }

    companion object {
        const val DEFAULT_EFFORT = "/api/settings/default-effort"
        const val HOST_OFFLINE_GRACE = "/api/settings/host-offline-grace"
        private val JSON = "application/json".toMediaType()
        private val json = Json { ignoreUnknownKeys = true }
    }
}
