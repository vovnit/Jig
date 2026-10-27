package dev.nitochkin.jig

import android.util.Base64
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.DataFormatException
import java.util.zip.Inflater
import org.json.JSONObject

/**
 * Entries of zip archives (EPUBs are zips) for the Phase F book actions:
 * `zip.list {app, id}` and `zip.read {app, id, path, as}`. The bytes come only
 * from the Phase E `files.read` service, never from a file path; until that
 * service exists these answer its error. Stored and deflated entries; anything
 * else, or a broken archive, answers an error. The directory is cached per
 * (app, id), and outputs are capped so a corrupt archive can't blow memory.
 */
object ZipArchive {
    private data class Entry(val path: String, val method: Int, val data: Int, val compSize: Int, val size: Int)
    private data class Dir(val bytes: ByteArray, val entries: List<Entry>)

    private const val MAX_ARCHIVE = 64 * 1024 * 1024
    private const val MAX_ENTRY = 16 * 1024 * 1024
    private const val MAX_ENTRIES = 5000

    private val cache = HashMap<String, Dir>()

    fun list(args: JSONObject, done: (String) -> Unit) {
        dir(args, done) { d ->
            Services.result(JSONObject().put("entries", org.json.JSONArray(d.entries.map { JSONObject().put("path", it.path).put("size", it.size) })))
        }
    }

    fun read(args: JSONObject, done: (String) -> Unit) {
        val path = args.optString("path")
        val asBase64 = args.optString("as") == "base64"
        dir(args, done) { (bytes, entries) ->
            val entry = entries.find { it.path == path } ?: return@dir Services.error("No '$path' in this file")
            val raw = runCatching { inflate(bytes, entry) }.getOrElse { return@dir Services.error(it.message ?: "That file isn't a zip archive") }
            Services.result(JSONObject().put("data", if (asBase64) Base64.encodeToString(raw, Base64.NO_WRAP) else raw.toString(Charsets.UTF_8)))
        }
    }

    private fun dir(args: JSONObject, done: (String) -> Unit, use: (Dir) -> String) {
        val key = "${args.optString("app")}\n${args.optString("id")}"
        synchronized(cache) { cache[key]?.let { done(use(it)); return } }
        fileBytes(args.optString("app"), args.optString("id")) { bytes, error ->
            if (bytes == null) return@fileBytes done(Services.error(error ?: "No file"))
            if (bytes.size > MAX_ARCHIVE) return@fileBytes done(Services.error("That file is too big to open"))
            val entries = runCatching { parse(bytes) }.getOrElse { return@fileBytes done(Services.error(it.message ?: "That file isn't a zip archive")) }
            val dir = Dir(bytes, entries)
            synchronized(cache) { cache[key] = dir }
            done(use(dir))
        }
    }

    /** The stored file's bytes through `files.read` (the whole file as base64). */
    private fun fileBytes(app: String, id: String, done: (ByteArray?, String?) -> Unit) {
        Services.handle(
            "files.read",
            JSONObject().put("app", app).put("id", id).put("as", "base64").toString(),
            { json ->
                val result = runCatching { JSONObject(json) }.getOrNull()?.optJSONObject("result")
                if (result == null) {
                    val error = runCatching { JSONObject(json).optString("error", "No file") }.getOrDefault("No file")
                    done(null, error)
                } else {
                    done(runCatching { Base64.decode(result.optString("data"), Base64.DEFAULT) }.getOrNull(), "Bad 'files.read' answer")
                }
            },
            {},
        )
    }

    /** The central directory: every entry's path, method and data offset, bounds-checked. */
    private fun parse(bytes: ByteArray): List<Entry> {
        if (bytes.size < 22) throw IllegalArgumentException("That file isn't a zip archive")
        val view = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val get16 = { at: Int -> view.getShort(at).toInt() and 0xffff }
        val get32 = { at: Int -> view.getInt(at).toLong() and 0xffffffffL }
        // The end-of-central-directory record sits in the last 64K + 22 bytes.
        var eocd = -1
        var at = bytes.size - 22
        while (at >= maxOf(0, bytes.size - 65557)) {
            if (get32(at) == 0x06054b50L) {
                eocd = at
                break
            }
            at--
        }
        if (eocd < 0) throw IllegalArgumentException("That file isn't a zip archive")
        val count = get16(eocd + 10)
        val cdSize = get32(eocd + 12)
        val cdOff = get32(eocd + 16)
        if (count > MAX_ENTRIES) throw IllegalArgumentException("That file has too many entries to open")
        if (cdOff + cdSize > bytes.size) throw IllegalArgumentException("That file isn't a zip archive")
        val entries = ArrayList<Entry>(minOf(count, 1024))
        at = cdOff.toInt()
        repeat(count) {
            if (at + 46 > bytes.size || get32(at) != 0x02014b50L) throw IllegalArgumentException("That file isn't a zip archive")
            val flags = get16(at + 8)
            val method = get16(at + 10)
            val compSize = get32(at + 20)
            val size = get32(at + 24)
            val nameLen = get16(at + 28)
            val extraLen = get16(at + 30)
            val commentLen = get16(at + 32)
            val localOff = get32(at + 42)
            at += 46
            if (at + nameLen + extraLen + commentLen > bytes.size) throw IllegalArgumentException("That file isn't a zip archive")
            val path = bytes.decodeToString(at, at + nameLen)
            at += nameLen + extraLen + commentLen
            if (path.endsWith("/")) return@repeat // a directory
            if (method != 0 && method != 8) throw IllegalArgumentException("'$path' uses an unsupported compression")
            if (flags and 0x01 != 0) throw IllegalArgumentException("'$path' is encrypted")
            if (flags and 0x08 != 0) throw IllegalArgumentException("'$path' has no directory sizes")
            if (compSize == 0xffffffffL || size == 0xffffffffL) throw IllegalArgumentException("'$path' needs zip64")
            if (size > MAX_ENTRY) throw IllegalArgumentException("'$path' is too big to open")
            // The local header repeats the shape; the data follows its name and extra fields.
            val local = localOff.toInt()
            if (local + 30 > bytes.size || get32(local) != 0x04034b50L) throw IllegalArgumentException("That file isn't a zip archive")
            val data = local + 30 + get16(local + 26) + get16(local + 28)
            if (data.toLong() + compSize > bytes.size) throw IllegalArgumentException("That file isn't a zip archive")
            entries.add(Entry(path, method, data, compSize.toInt(), size.toInt()))
        }
        return entries
    }

    private fun inflate(bytes: ByteArray, entry: Entry): ByteArray {
        if (entry.method == 0) {
            if (entry.compSize != entry.size) throw DataFormatException("That file isn't a zip archive")
            return bytes.copyOfRange(entry.data, entry.data + entry.compSize)
        }
        val inflater = Inflater(true) // raw deflate, which zip uses
        try {
            inflater.setInput(bytes, entry.data, entry.compSize)
            val out = ByteArray(entry.size)
            var total = 0
            while (!inflater.finished() && total < out.size) {
                val n = inflater.inflate(out, total, out.size - total)
                if (n == 0) break
                total += n
            }
            if (!inflater.finished() || total != out.size) throw DataFormatException("That file isn't a zip archive")
            return out
        } finally {
            inflater.end()
        }
    }
}
