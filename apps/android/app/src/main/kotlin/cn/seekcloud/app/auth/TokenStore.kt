package cn.seekcloud.app.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import cn.seekcloud.app.net.KeyValueStore
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 加密和解密令牌用的。App 里是 [KeystoreCipher]，测试里是普通的 AES。 */
interface SecretCipher {
    fun encrypt(plain: ByteArray): ByteArray
    fun decrypt(sealed: ByteArray): ByteArray
}

/**
 * AES-GCM，密钥在 Android Keystore 里生成、导不出来（#205 的安全要求）：存下来的只有密文，
 * 拷走 App 的数据也解不开。前 12 个字节是随机的 IV。
 */
class KeystoreCipher(private val alias: String = "seekcloud.device-tokens") : SecretCipher {
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        return cipher.iv + cipher.doFinal(plain)
    }

    override fun decrypt(sealed: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

/**
 * 每台主站的设备令牌（#205），按主站的编号存（换了地址也还是那台，令牌跟着保留）。
 * 只存密文；解不开（比如系统换了密钥）时当作没登录，重新登录就是。令牌不打日志、不进备份。
 */
class TokenStore(private val store: KeyValueStore, private val cipher: SecretCipher) {
    fun get(serverId: String): String? {
        val sealed = store.get(key(serverId)) ?: return null
        return runCatching { cipher.decrypt(Base64.getDecoder().decode(sealed)).decodeToString() }.getOrNull()
    }

    fun put(serverId: String, token: String) =
        store.put(key(serverId), Base64.getEncoder().encodeToString(cipher.encrypt(token.encodeToByteArray())))

    fun remove(serverId: String) = store.remove(key(serverId))

    private fun key(serverId: String) = "token:$serverId"
}
