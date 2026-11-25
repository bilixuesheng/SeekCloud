package cn.seekcloud.app.sessions

import cn.seekcloud.app.net.ServerClient
import cn.seekcloud.app.net.toApiException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 会话页（#182）用的接口，和网页的会话页一样。出错时抛 ApiException，连不上抛 IOException。
 */
interface SessionPageApi {
    /** 会话本身（标题、状态、仓库）；不存在时抛 404。 */
    fun session(shortId: String): SessionSummary

    /**
     * 发一条消息。会话在等回复就开始下一个回合；Agent 在工作时 [mode] 为 now 插进当前回合（下一步读到），
     * later 排队到这个回合结束。[model]、[effort] 不为 null 时从这个回合起换模型和思考强度（Agent 在工作时总是排队）。
     */
    fun send(shortId: String, text: String, mode: String, model: String? = null, effort: String? = null)

    /** 能用的模型和默认的思考强度（换模型的弹层用）。 */
    fun models(): ModelList

    /** 停下当前回合。 */
    fun stop(shortId: String)

    /** 撤回一条排队的消息，返回它的原文（放回输入框）。 */
    fun withdraw(shortId: String, queueId: String): String?

    /** 排队的消息立即发送（插进当前回合）。 */
    fun sendNow(shortId: String, queueId: String)

    /** 会话分支对比基础分支的改动（改动面板）。 */
    fun diff(shortId: String): List<RepoDiff>

    /** 置顶的回复。 */
    fun pins(shortId: String): List<MessagePin>

    /** 置顶或取消置顶一条回复（[seq] 是它的序号），返回新的列表。置顶时主站当场起短标题。 */
    fun setPinned(shortId: String, seq: Int, pinned: Boolean): List<MessagePin>
}

@Serializable
private data class Diffs(val repos: List<RepoDiff> = emptyList())

@Serializable
private data class Pins(val pins: List<MessagePin> = emptyList())

class HttpSessionPageApi(private val client: ServerClient) : SessionPageApi {
    override fun session(shortId: String): SessionSummary =
        json.decodeFromString(SessionSummary.serializer(), get("/api/sessions/$shortId"))

    override fun send(shortId: String, text: String, mode: String, model: String?, effort: String?) {
        val fields = listOfNotNull(
            "text" to JsonPrimitive(text),
            "mode" to JsonPrimitive(mode),
            model?.let { "model" to JsonPrimitive(it) },
            effort?.let { "effort" to JsonPrimitive(it) },
        )
        post("/api/sessions/$shortId/messages", *fields.toTypedArray())
    }

    override fun models(): ModelList = json.decodeFromString(ModelList.serializer(), get("/api/models"))

    override fun diff(shortId: String): List<RepoDiff> =
        json.decodeFromString(Diffs.serializer(), get("/api/sessions/$shortId/diff")).repos

    override fun pins(shortId: String): List<MessagePin> =
        json.decodeFromString(Pins.serializer(), get("/api/sessions/$shortId/pins")).pins

    override fun setPinned(shortId: String, seq: Int, pinned: Boolean): List<MessagePin> {
        val body = post("/api/sessions/$shortId/pins", "seq" to JsonPrimitive(seq), "pinned" to JsonPrimitive(pinned))
        return json.decodeFromString(Pins.serializer(), body).pins
    }

    override fun stop(shortId: String) {
        post("/api/sessions/$shortId/stop")
    }

    override fun withdraw(shortId: String, queueId: String): String? {
        val body = post("/api/sessions/$shortId/queue/$queueId/withdraw")
        return runCatching { (json.parseToJsonElement(body).jsonObject["text"] as? JsonPrimitive)?.contentOrNull }.getOrNull()
    }

    override fun sendNow(shortId: String, queueId: String) {
        post("/api/sessions/$shortId/queue/$queueId/send-now")
    }

    private fun get(path: String): String {
        val request = Request.Builder().url(client.address.url(path)).get().build()
        return client.http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw response.toApiException()
            response.body.string()
        }
    }

    private fun post(path: String, vararg fields: Pair<String, JsonElement>): String {
        val body: JsonObject = buildJsonObject { for ((k, v) in fields) put(k, v) }
        val request = Request.Builder().url(client.address.url(path)).post(body.toString().toRequestBody(JSON)).build()
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
