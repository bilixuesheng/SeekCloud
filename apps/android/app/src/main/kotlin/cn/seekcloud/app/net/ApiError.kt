package cn.seekcloud.app.net

import android.content.res.Resources
import cn.seekcloud.app.R
import java.io.IOException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Response

/** 主站接口出错时的格式（#204）：`{ "error": { "code": "...", "message": "..." } }`。 */
@Serializable
data class ApiError(val code: String, val message: String)

@Serializable
private data class ErrorBody(val error: ApiError? = null)

private val json = Json { ignoreUnknownKeys = true }

/** 读出错误；不是主站的格式（比如反向代理回的 502 页面）时返回 null。 */
fun parseApiError(body: String): ApiError? =
    runCatching { json.decodeFromString<ErrorBody>(body).error }.getOrNull()

/** 主站回了 2xx 以外的状态。[error] 是主站给的错误，[retryAfter] 是 Retry-After 的秒数。 */
class ApiException(
    val status: Int,
    val error: ApiError?,
    val retryAfter: Int? = null,
) : IOException("HTTP $status${error?.let { " ${it.code}" } ?: ""}")

/** 把出错的响应读成 [ApiException]（只读开头一段，错误的响应体都很短）。 */
fun Response.toApiException(): ApiException = ApiException(
    status = code,
    error = runCatching { peekBody(64 * 1024).string() }.getOrNull()?.let(::parseApiError),
    retryAfter = header("Retry-After")?.trim()?.toIntOrNull()?.takeIf { it > 0 },
)

/** 取文案：App 里是 [Resources]，测试里是假的。 */
interface ErrorTexts {
    fun string(id: Int): String
    fun plural(id: Int, count: Int): String
}

fun Resources.errorTexts(): ErrorTexts = object : ErrorTexts {
    override fun string(id: Int) = getString(id)
    override fun plural(id: Int, count: Int) = getQuantityString(id, count, count)
}

/**
 * 给人看的话，和网页上一样（网页的 i18n/errors.ts）：认得的 code 用文案目录里写好的（跟着系统语言），
 * 不认得的用主站给的 message；目录里写成空的（中文的 invalid_request 这类）也用主站给的，它带着具体哪一项不对。
 */
fun errorText(error: ApiError, retryAfter: Int?, texts: ErrorTexts): String {
    ERROR_PLURALS[error.code]?.let { id ->
        return if (retryAfter != null && retryAfter > 0) texts.plural(id, retryAfter) else error.message
    }
    val id = ERROR_MESSAGES[error.code] ?: return error.message
    return texts.string(id).ifEmpty { error.message }
}

/** 一次请求失败时给人看的话：主站给了错误就照上面说；没有给（不是主站的回应）说请求失败；连不上说网络异常。 */
fun failureText(failure: Throwable, texts: ErrorTexts): String = when {
    failure is ApiException && failure.error != null -> errorText(failure.error, failure.retryAfter, texts)
    failure is ApiException -> texts.string(R.string.error_request_failed)
    else -> texts.string(R.string.error_network)
}
