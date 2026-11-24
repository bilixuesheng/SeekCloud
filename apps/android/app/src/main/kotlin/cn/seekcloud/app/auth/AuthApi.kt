package cn.seekcloud.app.auth

import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.ServerClient
import cn.seekcloud.app.net.toApiException
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/** 登录第一步的结果：拿到设备令牌，或者开了两步验证、要再输验证码。 */
sealed interface LoginResult {
    /** [toString] 不带令牌：令牌不进日志。 */
    class Token(val token: String) : LoginResult {
        override fun toString() = "Token(***)"
    }

    class SecondFactor(val pendingToken: String) : LoginResult {
        override fun toString() = "SecondFactor(***)"
    }
}

@Serializable
private data class LoginBody(val password: String, val client: String = "app", val deviceName: String)

@Serializable
private data class VerifyBody(val pendingToken: String, val code: String)

@Serializable
private data class LoginReply(val token: String? = null, val pendingToken: String? = null)

/** 当前登录的管理员（`/api/me`），App 只用得到昵称。 */
@Serializable
data class Me(val nickname: String? = null)

/** 登录相关的接口（测试里换成假的）。出错时抛 [ApiException]，连不上抛 IOException。 */
interface Auth {
    fun login(password: String, deviceName: String): LoginResult
    fun verify(pendingToken: String, code: String): LoginResult
    /** 用设备令牌问一下是谁：令牌被吊销了、主站还没设置密码时抛 401 的 [ApiException]。 */
    fun me(): Me
    /** 退出登录：主站上删掉这台设备的登录状态。 */
    fun logout()
}

/**
 * 登录相关的接口（#205）。生成的接口代码认不出 `/api/auth/login` 的两种成功（200 带令牌、202 要两步验证），这几个手写。
 * 出错时抛 [ApiException]，连不上抛 IOException。
 */
class AuthApi(private val client: ServerClient) : Auth {
    override fun login(password: String, deviceName: String): LoginResult =
        reply(post("/api/auth/login", json.encodeToString(LoginBody(password, deviceName = deviceName))))

    override fun verify(pendingToken: String, code: String): LoginResult =
        reply(post("/api/auth/login/verify", json.encodeToString(VerifyBody(pendingToken, code.trim()))))

    override fun me(): Me = call(Request.Builder().url(client.address.url("/api/me")).get().build()) {
        json.decodeFromString<Me>(it)
    }

    override fun logout() {
        call(Request.Builder().url(client.address.url("/api/auth/logout")).post(EMPTY).build()) {}
    }

    private fun post(path: String, body: String) =
        Request.Builder().url(client.address.url(path)).post(body.toRequestBody(JSON)).build()

    private fun reply(request: Request): LoginResult = call(request) { text ->
        val reply = json.decodeFromString<LoginReply>(text)
        reply.token?.let { LoginResult.Token(it) }
            ?: reply.pendingToken?.let { LoginResult.SecondFactor(it) }
            ?: throw ApiException(200, null)
    }

    private fun <T> call(request: Request, read: (String) -> T): T =
        client.http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw response.toApiException()
            // 回的不是主站的格式（中间的代理换了页面这类）：当作请求失败，不让 App 崩掉
            try {
                read(response.body.string())
            } catch (_: SerializationException) {
                throw ApiException(response.code, null)
            }
        }

    private companion object {
        val JSON = "application/json".toMediaType()
        val EMPTY: RequestBody = ByteArray(0).toRequestBody(JSON)
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    }
}
