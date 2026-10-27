package dev.nitochkin.jig

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A per-app file store, behind `files.*` and the pickers: `filesDir/files/<app>/`
 * with a small JSON index of the handles. Pickers copy into it; `jig-file:<app>/<id>`
 * loads from it; deleting the app clears it.
 */
object FileStore {
    data class Handle(val id: String, val name: String, val type: String, val size: Int) {
        fun toJson() = JSONObject().put("id", id).put("name", name).put("type", type).put("size", size)
    }

    private fun dir(context: Context, app: String): File =
        File(File(context.filesDir, "files"), app).apply { mkdirs() }

    private fun indexFile(context: Context, app: String) = File(dir(context, app), "index.json")

    private fun readIndex(context: Context, app: String): MutableList<Handle> {
        val raw = runCatching { indexFile(context, app).readText() }.getOrNull() ?: return mutableListOf()
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return mutableListOf()
        return (0 until array.length()).mapNotNull { i ->
            runCatching {
                val o = array.getJSONObject(i)
                Handle(o.getString("id"), o.getString("name"), o.getString("type"), o.getInt("size"))
            }.getOrNull()
        }.toMutableList()
    }

    private fun saveIndex(context: Context, app: String, handles: List<Handle>) {
        val array = JSONArray()
        handles.forEach { array.put(it.toJson()) }
        runCatching { indexFile(context, app).writeText(array.toString()) }
    }

    private fun freshId(context: Context, app: String): String {
        val known = readIndex(context, app).map { it.id }.toSet()
        var id: String
        do {
            id = "f" + UUID.randomUUID().toString().take(8).lowercase()
        } while (id in known)
        return id
    }

    /** Stores bytes, returning the handle. */
    fun write(context: Context, app: String, name: String, type: String, bytes: ByteArray): JSONObject {
        val id = freshId(context, app)
        File(dir(context, app), id).writeBytes(bytes)
        val handle = Handle(id, name, type, bytes.size)
        val index = readIndex(context, app).filter { it.id != id } + handle
        saveIndex(context, app, index)
        return handle.toJson()
    }

    /** The bytes of a stored file, sliced to `offset`/`length` when given; null when missing. */
    fun read(context: Context, app: String, id: String, offset: Int = 0, length: Int? = null): ByteArray? {
        val bytes = runCatching { File(dir(context, app), id).readBytes() }.getOrNull() ?: return null
        val start = offset.coerceIn(0, bytes.size)
        val end = length?.let { (start + max(0, it)).coerceIn(start, bytes.size) } ?: bytes.size
        return bytes.copyOfRange(start, end)
    }

    /** The stored file itself (nil when gone), for players and the share sheet. */
    fun file(context: Context, app: String, id: String): File? =
        File(dir(context, app), id).takeIf { it.isFile }

    /** A handle by id, from the index (null when forgotten). */
    fun handle(context: Context, app: String, id: String): Handle? =
        readIndex(context, app).firstOrNull { it.id == id }

    /**
     * A temporary copy of a stored file named with the handle's original name, for
     * the share sheet (which would otherwise show the id-named store file). Earlier
     * copies are removed first, so the directory never grows.
     */
    fun shareCopy(context: Context, app: String, id: String): File? {
        val handle = handle(context, app, id) ?: return null
        val bytes = runCatching { File(dir(context, app), id).readBytes() }.getOrNull() ?: return null
        val out = File(context.cacheDir, "shared").apply { mkdirs() }
        out.listFiles()?.forEach { runCatching { it.delete() } }
        val name = handle.name.substringAfterLast('/').takeIf { it.isNotEmpty() } ?: id
        return File(out, name).apply { writeBytes(bytes) }
    }

    fun delete(context: Context, app: String, id: String) {
        runCatching { File(dir(context, app), id).delete() }
        saveIndex(context, app, readIndex(context, app).filter { it.id != id })
    }

    fun clear(context: Context, app: String) {
        runCatching { File(File(context.filesDir, "files"), app).deleteRecursively() }
    }

    /** The display name of a picked document, if the provider knows it. */
    fun displayName(resolver: ContentResolver, uri: Uri): String? {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) return c.getString(0)
        }
        return uri.lastPathSegment?.substringAfterLast('/')
    }

    /** The MIME type of a picked document: the provider's, else from the extension. */
    fun mimeType(resolver: ContentResolver, uri: Uri, fallbackName: String): String {
        resolver.getType(uri)?.let { return it }
        val ext = MimeTypeMap.getFileExtensionFromUrl(fallbackName)?.lowercase()
        if (!ext.isNullOrEmpty()) MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let { return it }
        return "application/octet-stream"
    }

    /** Photo bytes as a JPEG whose long side is at most 2048 px; null when not an image. */
    fun downscalePhoto(bytes: ByteArray, maxSide: Int = 2048): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > maxSide * 2 || bounds.outHeight / sample > maxSide * 2) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val scale = minOf(1f, maxSide / max(bitmap.width, bitmap.height).toFloat())
        val scaled = if (scale < 1f) {
            Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).roundToInt().coerceAtLeast(1), (bitmap.height * scale).roundToInt().coerceAtLeast(1), true)
        } else bitmap
        val out = ByteArrayOutputStream()
        if (!scaled.compress(Bitmap.CompressFormat.JPEG, 92, out)) return null
        return out.toByteArray()
    }
}
