package cn.seekcloud.app.sessions

import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ServerClient
import cn.seekcloud.app.net.toApiException
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 会话菜单里的操作（#124），用的是网页一样的接口。改完以后列表由事件流推回来的为准，不在本地改。
 * 出错时抛 [ApiException]，连不上抛 IOException。
 */
interface SessionActions {
    fun rename(shortId: String, title: String)
    fun setPinned(shortId: String, pinned: Boolean)
    fun setUnread(shortId: String, unread: Boolean)
    fun archive(shortId: String)
    fun unarchive(shortId: String)
    fun delete(shortId: String)

    /** 放进分组的最上面；[groupId] 为 null 时移出分组，回到"最近"。 */
    fun moveToGroup(shortId: String, groupId: String?)

    /** 新建一个分组，返回它的编号。 */
    fun createGroup(name: String): String
}

@Serializable
private data class Created(val id: String)

class SessionsApi(private val client: ServerClient) : SessionActions {
    override fun rename(shortId: String, title: String) = post("rename", shortId, "title" to JsonPrimitive(title.trim()))
    override fun setPinned(shortId: String, pinned: Boolean) = post("pin", shortId, "pinned" to JsonPrimitive(pinned))
    override fun setUnread(shortId: String, unread: Boolean) = post("read", shortId, "unread" to JsonPrimitive(unread))
    override fun archive(shortId: String) = post("archive", shortId)
    override fun unarchive(shortId: String) = post("unarchive", shortId)
    override fun delete(shortId: String) = post("delete", shortId)

    override fun moveToGroup(shortId: String, groupId: String?) = if (groupId != null) {
        post("place", shortId, "section" to JsonPrimitive("group"), "groupId" to JsonPrimitive(groupId), "after" to JsonNull)
    } else {
        post("place", shortId, "section" to JsonPrimitive("recent"), "after" to JsonNull)
    }

    override fun createGroup(name: String): String {
        val text = send("/api/session-groups", body("name" to JsonPrimitive(name.trim())))
        return try {
            json.decodeFromString<Created>(text).id
        } catch (_: SerializationException) {
            throw ApiException(200, null)
        }
    }

    private fun post(action: String, shortId: String, vararg fields: Pair<String, JsonElement>) {
        send("/api/sessions/$shortId/$action", body(*fields))
    }

    private fun body(vararg fields: Pair<String, JsonElement>) =
        buildJsonObject { for ((k, v) in fields) put(k, v) }.toString()

    private fun send(path: String, body: String): String {
        val request = Request.Builder().url(client.address.url(path)).post(body.toRequestBody(JSON)).build()
        return client.http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw response.toApiException()
            response.body.string()
        }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        val json = Json { ignoreUnknownKeys = true }
    }
}
