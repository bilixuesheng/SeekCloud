package cn.seekcloud.app.sessions

import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import cn.seekcloud.app.net.ServerClient
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** 加载 Agent 回复里的一张图片；加载不了（地址不对、不是图片、太大、连不上）时返回 null。 */
fun interface ImageLoader {
    suspend fun load(url: String): ImageBitmap?
}

/** 图片最大这么多字节，再大的不加载。 */
private const val MAX_IMAGE_BYTES = 10L * 1024 * 1024
/** 解码以后长边最多这么多像素（大图按 2 的幂缩小，免得占满内存）。 */
private const val MAX_IMAGE_SIDE = 2048

/**
 * 主站自己的图片用主站的客户端加载（带设备令牌、认钉住的证书）；别的来源用一个干净的客户端：
 * 不带令牌、不带 Referer，令牌不会被送到别处。
 */
class HttpImageLoader(
    private val server: ServerClient,
    private val external: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build(),
) : ImageLoader {
    override suspend fun load(url: String): ImageBitmap? = withContext(Dispatchers.IO) {
        val target = url.toHttpUrlOrNull() ?: return@withContext null
        val http = if (sameOrigin(target, server.address.url("/"))) server.http else external
        val request = Request.Builder().url(target).header("Accept", "image/*").build()
        try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val body = response.body
                if (body.contentLength() > MAX_IMAGE_BYTES) return@use null
                val source = body.source()
                if (source.request(MAX_IMAGE_BYTES + 1)) return@use null
                decode(source.readByteArray())
            }
        } catch (_: IOException) {
            null
        }
    }

    private fun decode(bytes: ByteArray): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_SIDE) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
    }
}

/** 协议、主机、端口都一样才算主站自己的地址。 */
fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean = a.scheme == b.scheme && a.host == b.host && a.port == b.port
