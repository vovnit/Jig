package dev.nitochkin.jig

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Host services for the shell (`Host.call` in the runtime): HTTP for the model and audio for
 * spoken requests (screenshots need the renderer; JigRuntime handles those). Each call
 * answers once with JSON, `{"result": ...}` or `{"error": "..."}`, from a background thread.
 */
object Services {
    private val io = Executors.newCachedThreadPool()

    /** Asks the user for a runtime permission (set by the activity); calls back with the answer. */
    var requestPermission: ((String, (Boolean) -> Unit) -> Unit)? = null

    fun handle(service: String, argsJson: String, done: (String) -> Unit) {
        val args = runCatching { JSONObject(argsJson) }.getOrElse { JSONObject() }
        when (service) {
            "http" -> io.execute { done(http(args)) }
            "audio.start" -> {
                val ask = requestPermission ?: return done(error("Can't ask for the microphone here"))
                ask(android.Manifest.permission.RECORD_AUDIO) { granted ->
                    if (granted) io.execute { done(Recorder.start()) } else done(error("Microphone access is off for Jig"))
                }
            }
            "audio.stop" -> io.execute { done(Recorder.stop()) }
            else -> done(error("No '$service' service on Android"))
        }
    }

    private fun http(args: JSONObject): String = try {
        val url = URL(args.getString("url"))
        if (url.protocol != "https" && url.protocol != "http") error("A valid http(s) url is required")
        else {
            val c = url.openConnection() as HttpURLConnection
            c.requestMethod = args.optString("method", "GET")
            c.connectTimeout = 30_000
            c.readTimeout = 120_000
            args.optJSONObject("headers")?.let { h -> h.keys().forEach { c.setRequestProperty(it, h.getString(it)) } }
            if (args.has("body")) {
                c.doOutput = true
                c.outputStream.use { it.write(args.getString("body").toByteArray()) }
            }
            val status = c.responseCode
            val body = (if (status >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            c.disconnect()
            result(JSONObject().put("status", status).put("body", body))
        }
    } catch (e: Exception) {
        error(e.message ?: e.toString())
    }

    fun result(value: Any): String = JSONObject().put("result", value).toString()
    fun error(message: String): String = JSONObject().put("error", message).toString()
}

/** Records the microphone as 16 kHz mono 16-bit WAV, the format the model is sent. */
@android.annotation.SuppressLint("MissingPermission")
object Recorder {
    private const val RATE = 16000
    private var record: android.media.AudioRecord? = null
    private var reader: Thread? = null
    private val pcm = java.io.ByteArrayOutputStream()

    @Synchronized
    fun start(): String {
        if (record != null) return Services.error("Already recording")
        val size = maxOf(android.media.AudioRecord.getMinBufferSize(RATE, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT), 4096)
        val r = android.media.AudioRecord(android.media.MediaRecorder.AudioSource.MIC, RATE, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT, size)
        if (r.state != android.media.AudioRecord.STATE_INITIALIZED) return Services.error("The microphone isn't available")
        pcm.reset()
        r.startRecording()
        record = r
        reader = Thread {
            val buffer = ByteArray(size)
            while (record === r) {
                val n = r.read(buffer, 0, buffer.size)
                if (n > 0) synchronized(pcm) { pcm.write(buffer, 0, n) }
            }
        }.apply { start() }
        return Services.result(JSONObject())
    }

    @Synchronized
    fun stop(): String {
        val r = record ?: return Services.error("Not recording")
        record = null
        reader?.join(500)
        r.stop()
        r.release()
        val data = synchronized(pcm) { pcm.toByteArray() }
        return Services.result(JSONObject().put("data", android.util.Base64.encodeToString(wav(data), android.util.Base64.NO_WRAP)))
    }

    private fun wav(data: ByteArray): ByteArray {
        val header = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + data.size).put("WAVE".toByteArray())
        header.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2).putShort(2).putShort(16)
        header.put("data".toByteArray()).putInt(data.size)
        return header.array() + data
    }
}
