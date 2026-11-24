package cn.seekcloud.app.sessions

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * 会话事件流（`/api/sessions/{id}/events`）里落了库的事件（#182），照协议包的 SessionEvent。
 * [seq] 是会话里从 1 开始的序号，断线重连时带上最后一个；[turn] 是第几个回合，不属于回合的为 null。
 * 认不出的类型（主站比 App 新）读成 [Unknown]，序号照样记，界面上不显示。
 */
sealed interface SessionEvent {
    val seq: Int
    val at: String
    val turn: Int?

    /** 管理员的消息。[followUp] 不为 null 时是平台自动开的跟进回合（推送失败），界面上是一行提示。 */
    data class UserMessage(
        override val seq: Int,
        override val at: String,
        override val turn: Int?,
        val text: String,
        val queued: List<String>? = null,
        val injected: Boolean = false,
        val followUp: String? = null,
    ) : SessionEvent

    data class PushGaveUp(override val seq: Int, override val at: String, override val turn: Int?, val repos: List<String>) : SessionEvent
    data class MessageQueued(override val seq: Int, override val at: String, override val turn: Int?, val id: String, val text: String) : SessionEvent
    data class MessageWithdrawn(override val seq: Int, override val at: String, override val turn: Int?, val id: String) : SessionEvent
    data class ModelChanged(override val seq: Int, override val at: String, override val turn: Int?, val model: String, val effort: String) : SessionEvent
    data class Status(
        override val seq: Int,
        override val at: String,
        override val turn: Int?,
        val status: String,
        val detail: String?,
        val error: SafeError? = null,
    ) : SessionEvent

    data class TurnStarted(override val seq: Int, override val at: String, override val turn: Int?) : SessionEvent

    /** Agent 一步结束时的完整消息；[thinking] 是这一步的思考过程。 */
    data class Message(override val seq: Int, override val at: String, override val turn: Int?, val text: String, val thinking: String? = null) : SessionEvent
    data class ToolCall(override val seq: Int, override val at: String, override val turn: Int?, val callId: String, val name: String, val input: JsonElement) : SessionEvent
    data class ToolResult(override val seq: Int, override val at: String, override val turn: Int?, val callId: String, val output: String, val isError: Boolean) : SessionEvent
    data class Todo(override val seq: Int, override val at: String, override val turn: Int?, val items: List<TodoItem>) : SessionEvent
    data class Workspace(override val seq: Int, override val at: String, override val turn: Int?, val repos: List<RepoOutcome>) : SessionEvent
    data class TurnEnded(override val seq: Int, override val at: String, override val turn: Int?, val reason: String, val error: SafeError? = null) : SessionEvent
    data class Unknown(override val seq: Int, override val at: String, override val turn: Int?) : SessionEvent
}

/** 能给人看的错误：只有类别、上游的状态码和参考号（ADR 0007）。 */
@Serializable
data class SafeError(val code: String, val status: Int? = null, val ref: String? = null)

@Serializable
data class TodoItem(val content: String, val status: String)

@Serializable
data class FileChange(
    val path: String,
    val from: String? = null,
    val additions: Int = 0,
    val deletions: Int = 0,
    val binary: Boolean = false,
)

/** 一个仓库在一个回合结束时的情况：推送了没有、这一回合改了哪些文件。 */
@Serializable
data class RepoOutcome(
    val fullName: String,
    val push: String = "pushed",
    val files: List<FileChange> = emptyList(),
    val omittedFiles: Int = 0,
)

/** 模型在这个回合里的进度（只推送、不落库）：在想还是在写，到现在输出了多少 token。 */
@Serializable
data class ModelProgress(val phase: String, val tokens: Int)

/** 模型正在输出的一段文字（只推送、不落库）：[kind] 是 thinking 或 text。 */
@Serializable
data class TextDelta(val kind: String, val text: String)

private val json = Json { ignoreUnknownKeys = true }

/** 读一条事件；不是合法的事件（没有序号这类）时返回 null，调用方跳过。 */
fun parseSessionEvent(data: String): SessionEvent? = try {
    parseSessionEvent(json.parseToJsonElement(data).jsonObject)
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

private fun parseSessionEvent(o: JsonObject): SessionEvent? {
    val seq = o.int("seq") ?: return null
    val at = o.string("at").orEmpty()
    val turn = o.int("turn")
    fun text(key: String) = o.string(key).orEmpty()
    return when (o.string("type")) {
        "user.message" -> SessionEvent.UserMessage(
            seq, at, turn,
            text = text("text"),
            queued = (o["queued"] as? JsonArray)?.map { it.jsonPrimitive.content },
            injected = o.bool("injected") ?: false,
            followUp = o.string("followUp"),
        )
        "push.gave_up" -> SessionEvent.PushGaveUp(seq, at, turn, o.strings("repos"))
        "message.queued" -> SessionEvent.MessageQueued(seq, at, turn, text("id"), text("text"))
        "message.withdrawn" -> SessionEvent.MessageWithdrawn(seq, at, turn, text("id"))
        "model.changed" -> SessionEvent.ModelChanged(seq, at, turn, text("model"), text("effort"))
        "status" -> SessionEvent.Status(seq, at, turn, text("status"), o.string("detail"), o.decode<SafeError>("error"))
        "turn.started" -> SessionEvent.TurnStarted(seq, at, turn)
        "message" -> SessionEvent.Message(seq, at, turn, text("text"), o.string("thinking"))
        "tool.call" -> SessionEvent.ToolCall(seq, at, turn, text("callId"), text("name"), o["input"] ?: JsonNull)
        "tool.result" -> SessionEvent.ToolResult(seq, at, turn, text("callId"), text("output"), o.bool("isError") ?: false)
        "todo" -> SessionEvent.Todo(seq, at, turn, o.decode<List<TodoItem>>("items").orEmpty())
        "workspace" -> SessionEvent.Workspace(seq, at, turn, o.decode<List<RepoOutcome>>("repos").orEmpty())
        "turn.ended" -> SessionEvent.TurnEnded(seq, at, turn, text("reason"), o.decode<SafeError>("error"))
        else -> SessionEvent.Unknown(seq, at, turn)
    }
}

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

private inline fun <reified T> JsonObject.decode(key: String): T? {
    val element = this[key] ?: return null
    if (element is JsonNull) return null
    return try {
        json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), element)
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
}

/** 逐字输出的进度和增量（只推送的事件），读不懂时返回 null。 */
fun parseProgress(data: String): ModelProgress? = runCatching { json.decodeFromString<ModelProgress>(data) }.getOrNull()
fun parseDelta(data: String): TextDelta? = runCatching { json.decodeFromString<TextDelta>(data) }.getOrNull()

/** 工具调用的输入：字符串原样，别的写成缩进的 JSON（照网页的工具卡片）。 */
fun toolInputText(input: JsonElement): String =
    if (input is JsonPrimitive && input.isString) input.content else prettyJson.encodeToString(JsonElement.serializer(), input)

private val prettyJson = Json { prettyPrint = true }

/** 工具调用的一句话摘要：文件路径、命令、搜索词之类（照网页的 toolSummary）。 */
fun toolSummary(input: JsonElement): String {
    if (input is JsonPrimitive) return if (input.isString) input.content else ""
    val record = input as? JsonObject ?: return ""
    for (key in listOf("file_path", "path", "command", "pattern", "url", "query", "description")) {
        (record[key] as? JsonPrimitive)?.takeIf { it.isString }?.let { return it.content }
    }
    return record.values.firstNotNullOfOrNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()
}
