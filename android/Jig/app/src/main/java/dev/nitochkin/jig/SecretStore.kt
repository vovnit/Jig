package dev.nitochkin.jig

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secret `data` fields, encrypted with an AES-GCM key that never leaves the Android
 * Keystore. Ciphertexts live in a private preferences file keyed `app/key`; if the
 * key is lost (say, after a restore to another device) a secret reads as missing.
 * Used from the JS thread only. Methods return an error message, or null on success.
 */
class SecretStore(context: Context) {
    private val prefs = context.getSharedPreferences("jig-secrets", Context.MODE_PRIVATE)
    private var cachedKey: SecretKey? = null

    fun get(app: String, key: String): String? = try {
        prefs.getString("$app/$key", null)?.let { stored ->
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_SIZE))
            String(cipher.doFinal(bytes, IV_SIZE, bytes.size - IV_SIZE), Charsets.UTF_8)
        }
    } catch (e: Exception) {
        Log.w("Jig", "Cannot read secret '$key' of $app: ${e.message}")
        null
    }

    fun set(app: String, key: String, value: String): String? = attempt {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString("$app/$key", Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()
    }

    fun delete(app: String, key: String): String? = attempt { prefs.edit().remove("$app/$key").commit() }

    fun clear(app: String): String? = attempt {
        val edit = prefs.edit()
        prefs.all.keys.filter { it.startsWith("$app/") }.forEach(edit::remove)
        edit.commit()
    }

    private fun attempt(body: () -> Boolean): String? = try {
        if (body()) null else "Cannot write secure storage"
    } catch (e: Exception) {
        e.message ?: e.toString()
    }

    private fun key(): SecretKey {
        cachedKey?.let { return it }
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val key = keyStore.getKey(ALIAS, null) as? SecretKey ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
        cachedKey = key
        return key
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "jig-secrets"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12
    }
}
