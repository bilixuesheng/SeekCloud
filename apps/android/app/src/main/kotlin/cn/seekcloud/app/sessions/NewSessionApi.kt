package cn.seekcloud.app.sessions

import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ServerClient
import cn.seekcloud.app.net.toApiException
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
data class GitHubStatus(val connected: Boolean, val login: String? = null, val installUrl: String = "")

/** 能选的仓库：装了 App 的，搜的时候再加上搜到的公开仓库。 */
@Serializable
data class Repo(
    val fullName: String,
    val private: Boolean = false,
    val defaultBranch: String,
    val canPush: Boolean = true,
)

/** 环境：默认环境的名字是空的，界面按语言显示"默认环境"。 */
@Serializable
data class Environment(val id: String, val name: String, val isDefault: Boolean = false)

/** 一个能选的模型（`/api/models`）。[efforts] 是它支持的思考强度，空的就只有"关闭"。 */
@Serializable
data class ModelOption(
    val id: String,
    val provider: String = "",
    val providerName: String = "",
    val name: String = "",
    val efforts: List<String> = emptyList(),
    val vision: Boolean = false,
)

@Serializable
data class ModelProviderOption(val id: String, val name: String, val models: List<String> = emptyList())

@Serializable
data class ModelList(
    val models: List<ModelOption> = emptyList(),
    val providers: List<ModelProviderOption> = emptyList(),
    val defaultModel: String? = null,
    val defaultEffort: String = "high",
)

@Serializable
private data class Repos(val repos: List<Repo> = emptyList())

@Serializable
private data class Branches(val branches: List<String> = emptyList())

@Serializable
private data class Environments(val environments: List<Environment> = emptyList())

/** 要发起的会话。不选仓库时 [repo]、[baseBranch] 都是 null（#191）。 */
data class NewSessionRequest(
    val text: String,
    val repo: String? = null,
    val baseBranch: String? = null,
    val environmentId: String? = null,
    val model: String? = null,
    val effort: String? = null,
)

/** 新会话页要用的接口（#124），和网页的一样。出错时抛 [ApiException]，连不上抛 IOException。 */
interface NewSessionSource {
    fun github(): GitHubStatus
    fun repos(query: String? = null): List<Repo>
    fun branches(repo: String): List<String>
    fun environments(): List<Environment>
    fun models(): ModelList
    fun create(request: NewSessionRequest): SessionSummary

    /** 选了模型也就成了新会话的默认模型（照 dsh，网页也这样）。 */
    fun setDefaultModel(model: String)
}

class NewSessionApi(private val client: ServerClient) : NewSessionSource {
    override fun github(): GitHubStatus = get("/api/github/status")
    override fun repos(query: String?): List<Repo> =
        get<Repos>(url("/api/github/repos").newBuilder().apply { query?.let { addQueryParameter("q", it) } }.build()).repos

    override fun branches(repo: String): List<String> = get<Branches>("/api/github/repos/$repo/branches").branches
    override fun environments(): List<Environment> = get<Environments>("/api/environments").environments
    override fun models(): ModelList = get("/api/models")

    override fun create(request: NewSessionRequest): SessionSummary {
        val body = buildJsonObject {
            put("text", request.text)
            request.repo?.let { put("repo", it) }
            request.baseBranch?.let { put("baseBranch", it) }
            request.environmentId?.let { put("environmentId", it) }
            request.model?.let { put("model", it) }
            request.effort?.let { put("effort", it) }
        }
        return decode(send(Request.Builder().url(url("/api/sessions")).post(body.toString().toRequestBody(JSON)).build()))
    }

    override fun setDefaultModel(model: String) {
        val body = buildJsonObject { put("model", JsonPrimitive(model)) }.toString().toRequestBody(JSON)
        send(Request.Builder().url(url("/api/settings/default-model")).put(body).build())
    }

    private fun url(path: String): HttpUrl = client.address.url(path)

    private inline fun <reified T> get(path: String): T = get(url(path))

    private inline fun <reified T> get(url: HttpUrl): T = decode(send(Request.Builder().url(url).get().build()))

    private inline fun <reified T> decode(text: String): T = try {
        json.decodeFromString<T>(text)
    } catch (_: SerializationException) {
        throw ApiException(200, null)
    }

    private fun send(request: Request): String = client.http.newCall(request).execute().use { response ->
        if (!response.isSuccessful) throw response.toApiException()
        response.body.string()
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        val json = Json { ignoreUnknownKeys = true }
    }
}

/** 思考强度从低到高（协议包的 THINKING_EFFORTS）。 */
val THINKING_EFFORTS = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

/**
 * 模型不支持想要的那一档时换成最近的一档，一样近时取低的那档（照协议包的 fitEffort）。
 * 模型一档都没声明时返回 null。
 */
fun fitEffort(efforts: List<String>, effort: String): String? {
    if (effort in efforts) return effort
    val at = THINKING_EFFORTS.indexOf(effort)
    fun rank(e: String): Int {
        val i = THINKING_EFFORTS.indexOf(e)
        return kotlin.math.abs(i - at) * 2 + if (i > at) 1 else 0
    }
    return efforts.minByOrNull(::rank)
}
