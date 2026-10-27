package dev.nitochkin.jig

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Host services for the shell (`Host.call` in the runtime): HTTP for the model and audio for
 * spoken requests (screenshots need the renderer; JigRuntime handles those). Each call
 * answers once with JSON, `{"result": ...}` or `{"error": "..."}`, from a background thread,
 * after any number of progress updates (a streamed body's lines).
 */
object Services {
    private val io = Executors.newCachedThreadPool()

    /** Asks the user for a runtime permission (set by the activity); calls back with the answer. */
    var requestPermission: ((String, (Boolean) -> Unit) -> Unit)? = null

    /** Set by the activity: the context location and sensors need. */
    var appContext: Context? = null

    /** Set by the activity: haptics, wake lock and brightness go through its window. */
    var activity: android.app.Activity? = null

    /**
     * Starts an activity for a result (set by the activity, like the permission hook):
     * launches `intent` and calls back with the result code and data.
     */
    var startActivity: ((android.content.Intent, (Int, android.content.Intent?) -> Unit) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())

    fun handle(service: String, argsJson: String, done: (String) -> Unit, progress: (String) -> Unit) {
        val args = runCatching { JSONObject(argsJson) }.getOrElse { JSONObject() }
        when (service) {
            "schedule.set" -> main.post { appContext?.let { Schedules.set(it, args, done) } ?: done(error("No app context")) }
            "http" -> io.execute { done(http(args, progress)) }
            "audio.start" -> {
                val ask = requestPermission ?: return done(error("Can't ask for the microphone here"))
                ask(android.Manifest.permission.RECORD_AUDIO) { granted ->
                    if (granted) io.execute { done(Recorder.start()) } else done(error("Microphone access is off for Jig"))
                }
            }
            "audio.stop" -> io.execute { done(Recorder.stop()) }
            "location.watch" -> watchLocation(done, progress)
            "location.stop" -> stopLocation(done)
            "heading.watch" -> watchHeading(done, progress)
            "heading.stop" -> stopHeading(done)
            "haptic" -> haptic(args, done)
            "keepAwake" -> keepAwake(args, done)
            "brightness" -> setBrightness(args, done)
            "speak" -> speak(args, done)
            "stopSpeaking" -> stopSpeaking(done)
            "zip.list" -> ZipArchive.list(args, done)
            "zip.read" -> ZipArchive.read(args, done)
            "files.write" -> fileWrite(args, done)
            "files.read" -> fileRead(args, done)
            "files.delete" -> fileDelete(args, done)
            "files.clear" -> fileClear(args, done)
            "pickFile" -> pickFile(args, done)
            "pickPhoto" -> pickPhoto(args, done)
            "takePhoto" -> takePhoto(args, done)
            "share" -> share(args, done)
            "widgets.set" -> io.execute { appContext?.let { WidgetStore.set(it, args, done) } ?: done(error("No file store here")) }
            else -> done(error("No '$service' service on Android"))
        }
    }

    private fun http(args: JSONObject, progress: (String) -> Unit): String = try {
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
            val stream = if (status >= 400) c.errorStream else c.inputStream
            if (args.optBoolean("stream")) {
                // Server-sent events: each line goes to JS as it arrives.
                stream?.bufferedReader()?.use { r -> r.lineSequence().forEach { progress(JSONObject().put("line", it).toString()) } }
                c.disconnect()
                result(JSONObject().put("status", status).put("body", ""))
            } else {
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                c.disconnect()
                result(JSONObject().put("status", status).put("body", body))
            }
        }
    } catch (e: Exception) {
        error(e.message ?: e.toString())
    }

    fun result(value: Any): String = JSONObject().put("result", value).toString()
    fun error(message: String): String = JSONObject().put("error", message).toString()

    // ---------- Location (coarse, for sun times) ----------

    private var locationDone: ((String) -> Unit)? = null
    private var locationProgress: ((String) -> Unit)? = null
    private var locationListener: LocationListener? = null

    /**
     * Starts `location.watch`: permission first, then every fix as progress
     * `{lat, lon, accuracy}` (degrees, metres). The call never answers `done` with a
     * result: only `stop` (or a second `watch`, or an error) ends it, with `done({})`.
     */
    private fun watchLocation(done: (String) -> Unit, progress: (String) -> Unit) {
        // Every start, replace and stop runs on main, so a stop during start-up
        // can't slip in while main registers the listener.
        main.post {
            // A second watch replaces the first.
            endLocationWatch()
            locationDone = done
            locationProgress = progress
            val ask = requestPermission ?: return@post failLocation("Can't ask for location here")
            ask(android.Manifest.permission.ACCESS_COARSE_LOCATION) { granted ->
                if (granted) { if (locationDone === done) startLocationUpdates() }
                else failLocation("Location access is off for Jig")
            }
        }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun startLocationUpdates() {
        if (locationDone == null) return
        val ctx = appContext ?: return failLocation("No location available")
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        // Coarse is enough (a few hundred metres): it's for sun times and sundials.
        // No Play services: the platform's own providers.
        val provider = when {
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            else -> return failLocation("No location available")
        }
        // An object, not a lambda: before API 30 the other callbacks have no default and a
        // provider being switched off would crash the app.
        val listener = object : LocationListener {
            override fun onLocationChanged(fix: android.location.Location) {
                locationProgress?.invoke(JSONObject().put("lat", fix.latitude).put("lon", fix.longitude).put("accuracy", fix.accuracy).toString())
            }
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
            @Deprecated("Called only before API 29")
            override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        }
        locationListener = listener
        try {
            lm.requestLocationUpdates(provider, 1000L, 10f, listener, Looper.getMainLooper())
        } catch (e: SecurityException) {
            locationListener = null
            return failLocation("Location access is off for Jig")
        }
        // Report the last fix right away, so a sundial shows at once.
        runCatching { lm.getLastKnownLocation(provider) }.getOrNull()?.let { listener.onLocationChanged(it) }
    }

    /** Ends the watch's call with `done({})`, if there is one. */
    private fun endLocationWatch() {
        val done = locationDone ?: return
        locationDone = null
        locationProgress = null
        locationListener?.let { listener ->
            runCatching { (appContext?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager)?.removeUpdates(listener) }
            locationListener = null
        }
        done(result(JSONObject()))
    }

    private fun failLocation(message: String) {
        val done = locationDone ?: return
        locationDone = null
        locationProgress = null
        locationListener = null
        done(error(message))
    }

    private fun stopLocation(done: (String) -> Unit) {
        main.post {
            endLocationWatch()
            done(result(JSONObject()))
        }
    }

    // ---------- Heading (a compass for aligning a sundial) ----------

    private var headingDone: ((String) -> Unit)? = null
    private var headingProgress: ((String) -> Unit)? = null
    private var headingSensors: SensorManager? = null
    private var headingListener: SensorEventListener? = null
    private var lastDegrees = Double.NaN
    private var lastHeadingTime = 0L

    /**
     * Starts `heading.watch`: progress `{degrees, accuracy}` clockwise from (magnetic)
     * north from the rotation vector sensor, throttled to about 10 a second and only
     * when it moved by at least a degree. Ends like `location.watch`.
     */
    private fun watchHeading(done: (String) -> Unit, progress: (String) -> Unit) {
        // As with location: start, replace and stop all run on main, so they can't interleave.
        main.post {
            endHeadingWatch()
            headingDone = done
            headingProgress = progress
            // Registration needs a Looper, which main has.
            if (headingDone === done) startHeadingUpdates()
        }
    }

    private fun startHeadingUpdates() {
        if (headingDone == null) return
        val ctx = appContext ?: return failHeading("This device has no compass")
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) ?: return failHeading("This device has no compass")
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                val v = event.values
                if (v.size < 3) return
                val rotation = FloatArray(9)
                val orientation = FloatArray(3)
                SensorManager.getRotationMatrixFromVector(rotation, v)
                SensorManager.getOrientation(rotation, orientation)
                // Azimuth, clockwise from north, as 0..360.
                val degrees = (Math.toDegrees(orientation[0].toDouble()) + 360) % 360
                val now = SystemClock.uptimeMillis()
                if (!lastDegrees.isNaN()) {
                    val turn = Math.abs(degrees - lastDegrees) % 360
                    if (Math.min(turn, 360 - turn) < 1 || now - lastHeadingTime < 100) return
                }
                lastDegrees = degrees
                lastHeadingTime = now
                // The rotation vector's estimated accuracy, when the event carries one.
                val accuracy = if (v.size > 4 && v[4] != -1f) Math.toDegrees(v[4].toDouble()) else -1.0
                headingProgress?.invoke(JSONObject().put("degrees", degrees).put("accuracy", accuracy).toString())
            }

            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
        }
        headingSensors = sm
        headingListener = listener
        lastDegrees = Double.NaN
        sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI)
    }

    private fun endHeadingWatch() {
        val done = headingDone ?: return
        headingDone = null
        headingProgress = null
        headingListener?.let { headingSensors?.unregisterListener(it) }
        headingListener = null
        headingSensors = null
        done(result(JSONObject()))
    }

    private fun failHeading(message: String) {
        val done = headingDone ?: return
        headingDone = null
        headingProgress = null
        headingListener = null
        headingSensors = null
        done(error(message))
    }

    private fun stopHeading(done: (String) -> Unit) {
        main.post {
            endHeadingWatch()
            done(result(JSONObject()))
        }
    }

    // ---------- Files, pickers and sharing (Phase E) ----------

    /**
     * One system sheet at a time: the pickers, the camera and the share sheet share
     * the activity's single result slot, so a second request while one is open answers
     * at once instead of overwriting (and orphaning) the first. All callers run on
     * main, as do the result callbacks, so the flag needs no lock.
     */
    private var pickerOpen = false

    /** Claims the result slot, answering `done` with an error when one is already open. */
    private fun claimPicker(done: (String) -> Unit): Boolean {
        if (pickerOpen) {
            done(error("Another picker is open"))
            return false
        }
        pickerOpen = true
        return true
    }

    private fun releasePicker() {
        pickerOpen = false
    }

    /** Stores base64 bytes, answering the handle. */
    private fun fileWrite(args: JSONObject, done: (String) -> Unit) {
        val ctx = appContext ?: return done(error("No file store here"))
        val app = args.optString("app")
        if (app.isEmpty()) return done(error("A file needs an app"))
        val bytes = runCatching { android.util.Base64.decode(args.optString("data"), android.util.Base64.DEFAULT) }.getOrNull()
            ?: return done(error("Bad file data"))
        io.execute {
            val handle = FileStore.write(ctx, app, args.optString("name", "file"), args.optString("type", "application/octet-stream"), bytes)
            done(result(handle))
        }
    }

    /** Reads bytes (or a range of them) as text or base64: `{data}`. */
    private fun fileRead(args: JSONObject, done: (String) -> Unit) {
        val ctx = appContext ?: return done(error("No file store here"))
        io.execute {
            val bytes = FileStore.read(ctx, args.optString("app"), args.optString("id"), args.optInt("offset"), args.opt("length")?.let { (it as? Number)?.toInt() })
                ?: return@execute done(error("No such file"))
            if (args.optString("as") == "base64") {
                done(result(JSONObject().put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))))
            } else {
                val text = runCatching { String(bytes, Charsets.UTF_8) }.getOrNull()
                if (text == null) done(error("The file isn't text")) else done(result(JSONObject().put("data", text)))
            }
        }
    }

    private fun fileDelete(args: JSONObject, done: (String) -> Unit) {
        appContext?.let { FileStore.delete(it, args.optString("app"), args.optString("id")) }
        done(result(JSONObject()))
    }

    private fun fileClear(args: JSONObject, done: (String) -> Unit) {
        appContext?.let { FileStore.clear(it, args.optString("app")) }
        done(result(JSONObject()))
    }

    /** The picked documents' content URIs: every selected item, or the single one. */
    private fun collectUris(data: android.content.Intent?): List<android.net.Uri> {
        val clip = data?.clipData
        if (clip != null) return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        return listOfNotNull(data?.data)
    }

    /** Copies a picked document into the app's store. */
    private fun storePicked(app: String, uri: android.net.Uri): JSONObject? {
        val ctx = appContext ?: return null
        val bytes = runCatching { ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: return null
        val name = FileStore.displayName(ctx.contentResolver, uri)?.takeIf { it.isNotEmpty() } ?: "file"
        return FileStore.write(ctx, app, name, FileStore.mimeType(ctx.contentResolver, uri, name), bytes)
    }

    /** `accept` (extensions like "epub" or MIME patterns like "image/…") to a document intent type. */
    private fun documentMime(accept: List<String>): Pair<String, Array<String>?> {
        val mimes = accept.mapNotNull { entry ->
            if ("/" in entry) entry
            else android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(entry.trimStart('.').lowercase())
        }.distinct()
        if (mimes.isEmpty()) return "*/*" to null
        if (mimes.size == 1 && !mimes[0].endsWith("/*")) return mimes[0] to null
        return "*/*" to mimes.toTypedArray()
    }

    private fun pickFile(args: JSONObject, done: (String) -> Unit) {
        main.post {
            val launch = startActivity
            val app = args.optString("app")
            if (launch == null) {
                done(error("Can't open files here"))
            } else if (app.isEmpty()) {
                done(error("A file needs an app"))
            } else if (!claimPicker(done)) {
                // Already answered with "Another picker is open".
            } else {
                val accept = args.optJSONArray("accept")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotEmpty() } } } ?: emptyList()
                val (type, extra) = documentMime(accept)
                val intent = android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(android.content.Intent.CATEGORY_OPENABLE)
                    this.type = type
                    if (extra != null) putExtra(android.content.Intent.EXTRA_MIME_TYPES, extra)
                    if (args.optBoolean("multiple")) putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true)
                    addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                launch(intent) { code, data ->
                    releasePicker()
                    val uris = if (code == android.app.Activity.RESULT_OK) collectUris(data) else emptyList()
                    if (uris.isEmpty()) {
                        done(error("Cancelled"))
                    } else {
                        io.execute {
                            val handles = uris.mapNotNull { storePicked(app, it) }
                            if (handles.isEmpty()) done(error("Couldn't read the file"))
                            else done(result(if (args.optBoolean("multiple")) org.json.JSONArray(handles) else handles[0]))
                        }
                    }
                }
            }
        }
    }

    private fun pickPhoto(args: JSONObject, done: (String) -> Unit) {
        main.post {
            val launch = startActivity
            val app = args.optString("app")
            if (launch == null) {
                done(error("Can't open photos here"))
            } else if (app.isEmpty()) {
                done(error("A photo needs an app"))
            } else if (!claimPicker(done)) {
                // Already answered with "Another picker is open".
            } else {
                val multiple = args.optBoolean("multiple")
                // The system Photo Picker on API 33+, else an image document.
                val intent = if (Build.VERSION.SDK_INT >= 33) {
                    android.content.Intent(android.provider.MediaStore.ACTION_PICK_IMAGES).apply {
                        putExtra(android.provider.MediaStore.EXTRA_PICK_IMAGES_MAX, if (multiple) 10 else 1)
                    }
                } else {
                    android.content.Intent(android.content.Intent.ACTION_GET_CONTENT).apply {
                        addCategory(android.content.Intent.CATEGORY_OPENABLE)
                        type = "image/*"
                        if (multiple) putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }
                launch(intent) { code, data ->
                    releasePicker()
                    val uris = if (code == android.app.Activity.RESULT_OK) collectUris(data) else emptyList()
                    if (uris.isEmpty()) {
                        done(error("Cancelled"))
                    } else {
                        io.execute {
                            val handles = uris.mapNotNull { storePhoto(app, it) }
                            if (handles.isEmpty()) done(error("Couldn't read the photo"))
                            else done(result(if (multiple) org.json.JSONArray(handles) else handles[0]))
                        }
                    }
                }
            }
        }
    }

    /** Copies a picked photo into the store as a downscaled JPEG. */
    private fun storePhoto(app: String, uri: android.net.Uri): JSONObject? {
        val ctx = appContext ?: return null
        val bytes = runCatching { ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: return null
        val jpeg = FileStore.downscalePhoto(bytes) ?: return null
        val base = (FileStore.displayName(ctx.contentResolver, uri)?.substringBeforeLast('.')?.takeIf { it.isNotEmpty() }) ?: "photo"
        return FileStore.write(ctx, app, "$base.jpg", "image/jpeg", jpeg)
    }

    private var pendingCapture: java.io.File? = null

    private fun takePhoto(args: JSONObject, done: (String) -> Unit) {
        main.post {
            val ask = requestPermission
            if (ask == null) {
                done(error("Can't ask for the camera here"))
            } else if (!claimPicker(done)) {
                // Already answered with "Another picker is open".
            } else {
                ask(android.Manifest.permission.CAMERA) { granted ->
                    takePhotoAfterPermission(args, granted, done)
                }
            }
        }
    }

    /** Launches the camera once the permission answer is in. */
    private fun takePhotoAfterPermission(args: JSONObject, granted: Boolean, done: (String) -> Unit) {
        if (!granted) {
            releasePicker()
            done(error("Camera access is off for Jig"))
            return
        }
        val ctx = appContext
        val launch = startActivity
        val app = args.optString("app")
        if (ctx == null) {
            releasePicker()
            done(error("No file store here"))
        } else if (launch == null) {
            releasePicker()
            done(error("Can't take photos here"))
        } else if (app.isEmpty()) {
            releasePicker()
            done(error("A photo needs an app"))
        } else {
            val out = java.io.File(java.io.File(ctx.cacheDir, "capture").apply { mkdirs() }, "photo-${System.currentTimeMillis()}.jpg")
            val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", out)
            val intent = android.content.Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
                addFlags(android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            val handlers = ctx.packageManager.queryIntentActivities(intent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
            if (handlers.isEmpty()) {
                releasePicker()
                done(error("This device has no camera"))
            } else {
                // Let the camera app write to our URI.
                handlers.forEach {
                    ctx.grantUriPermission(it.activityInfo.packageName, uri, android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
                pendingCapture = out
                launch(intent) { code, _ ->
                    releasePicker()
                    val file = pendingCapture
                    pendingCapture = null
                    if (code != android.app.Activity.RESULT_OK) {
                        file?.delete()
                        done(error("Cancelled"))
                    } else {
                        io.execute {
                            val bytes = file?.takeIf { it.isFile }?.readBytes()
                            file?.delete()
                            val jpeg = bytes?.let { FileStore.downscalePhoto(it) }
                            if (jpeg == null) done(error("Couldn't read the photo"))
                            else done(result(FileStore.write(ctx, app, "photo.jpg", "image/jpeg", jpeg)))
                        }
                    }
                }
            }
        }
    }

    private fun share(args: JSONObject, done: (String) -> Unit) {
        main.post {
            val ctx = appContext ?: return@post done(error("Can't share here"))
            val launch = startActivity ?: return@post done(error("Can't share here"))
            if (!claimPicker(done)) return@post
            val finish = { json: String ->
                releasePicker()
                done(json)
            }
            val text = args.optString("text").takeIf { it.isNotEmpty() }
            val url = args.optString("url").takeIf { it.isNotEmpty() }
            val fileId = args.optString("file").takeIf { it.isNotEmpty() }
            val send = android.content.Intent(android.content.Intent.ACTION_SEND)
            var type: String? = null
            if (fileId != null) {
                val app = args.optString("app")
                val handle = FileStore.handle(ctx, app, fileId) ?: return@post finish(error("No such file"))
                // A temporary copy named with the handle's original name, so the
                // receiver sees "book.epub" instead of the id-named store file.
                val copy = FileStore.shareCopy(ctx, app, fileId) ?: return@post finish(error("No such file"))
                val uri = runCatching { androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", copy) }.getOrNull()
                    ?: return@post finish(error("No such file"))
                // The MIME type comes from the handle's stored type, not the file.
                type = handle.type.takeIf { it.isNotEmpty() } ?: "application/octet-stream"
                send.putExtra(android.content.Intent.EXTRA_STREAM, uri)
                send.clipData = android.content.ClipData.newUri(ctx.contentResolver, "file", uri)
                send.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val combined = listOfNotNull(text, url).joinToString(" ").takeIf { it.isNotEmpty() }
            if (combined != null) send.putExtra(android.content.Intent.EXTRA_TEXT, combined)
            if (fileId == null && combined == null) return@post finish(error("Nothing to share"))
            send.type = type ?: "text/plain"
            // Answered with {} when the sheet is dismissed, shared or not.
            launch(android.content.Intent.createChooser(send, null)) { _, _ -> finish(result(JSONObject())) }
        }
    }

    // ---------- Haptics, wake lock, brightness, speech (Phase C) ----------

    /** A tap on the root view with the closest constant per style. */
    private fun haptic(args: JSONObject, done: (String) -> Unit) {
        val constant = when (args.optString("style")) {
            "light" -> HapticFeedbackConstants.KEYBOARD_TAP
            "medium" -> HapticFeedbackConstants.VIRTUAL_KEY
            "heavy" -> HapticFeedbackConstants.LONG_PRESS
            "success" -> if (Build.VERSION.SDK_INT >= 27) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS
            "warning" -> HapticFeedbackConstants.CLOCK_TICK
            "error" -> if (Build.VERSION.SDK_INT >= 27) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
            else -> HapticFeedbackConstants.VIRTUAL_KEY
        }
        main.post {
            runCatching { activity?.window?.decorView?.performHapticFeedback(constant) }
            done(result(JSONObject()))
        }
    }

    /** Keeps the screen from sleeping while on. */
    private fun keepAwake(args: JSONObject, done: (String) -> Unit) {
        val on = args.optBoolean("on")
        main.post {
            activity?.window?.let {
                if (on) it.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else it.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            done(result(JSONObject()))
        }
    }

    /** Sets the window brightness (0..1); `null` restores the system's. */
    private fun setBrightness(args: JSONObject, done: (String) -> Unit) {
        main.post {
            activity?.window?.let {
                val lp = it.attributes
                lp.screenBrightness = if (args.isNull("level")) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                else args.optDouble("level", -1.0).toFloat().coerceIn(0f, 1f)
                it.attributes = lp
            }
            done(result(JSONObject()))
        }
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var speakDone: ((String) -> Unit)? = null
    private var pendingSpeak: Triple<String, Float, (String) -> Unit>? = null

    /**
     * Speaks the text aloud, answering when it finishes (or is stopped). `rate`
     * 0.5..2, default 1. The engine starts lazily, once; a new request (or
     * `stopSpeaking`) ends the previous one with `{}`.
     */
    private fun speak(args: JSONObject, done: (String) -> Unit) {
        main.post {
            val waiting = pendingSpeak
            pendingSpeak = null
            waiting?.third?.invoke(result(JSONObject()))
            val previous = speakDone
            speakDone = null
            tts?.stop()
            previous?.let { it(result(JSONObject())) }
            val text = args.optString("text")
            if (text.isEmpty()) return@post done(error("Nothing to say"))
            val rate = args.optDouble("rate", 1.0).let { if (it.isNaN()) 1.0 else it }.toFloat().coerceIn(0.5f, 2f)
            if (ttsReady && tts != null) doSpeak(text, rate, done)
            else {
                pendingSpeak = Triple(text, rate, done)
                ensureTts()
            }
        }
    }

    private fun ensureTts() {
        if (tts != null) return
        val ctx = appContext ?: run {
            pendingSpeak?.third?.let { it(error("Speech isn't available")) }
            pendingSpeak = null
            return
        }
        tts = TextToSpeech(ctx) { status ->
            main.post {
                ttsReady = status == TextToSpeech.SUCCESS
                val pending = pendingSpeak
                pendingSpeak = null
                if (!ttsReady) {
                    tts?.shutdown()
                    tts = null
                    pending?.third?.let { it(error("Speech isn't available")) }
                    return@post
                }
                pending?.let { (text, rate, done) -> doSpeak(text, rate, done) }
            }
        }
    }

    private fun doSpeak(text: String, rate: Float, done: (String) -> Unit) {
        val engine = tts ?: return done(error("Speech isn't available"))
        speakDone = done
        engine.setSpeechRate(rate)
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}

            override fun onDone(utteranceId: String?) {
                main.post {
                    if (speakDone === done) {
                        speakDone = null
                        done(result(JSONObject()))
                    }
                }
            }

            override fun onError(utteranceId: String?) {
                main.post {
                    if (speakDone === done) {
                        speakDone = null
                        done(error("Speech was interrupted"))
                    }
                }
            }

            @Deprecated("Only the new callback is used")
            override fun onError(utteranceId: String?, errorCode: Int) {
                onError(utteranceId)
            }
        })
        if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jig-speak") == TextToSpeech.ERROR) {
            speakDone = null
            done(error("Speech failed"))
        }
    }

    /** Stops speaking now; the pending `speak` answers `{}`. */
    private fun stopSpeaking(done: (String) -> Unit) {
        main.post {
            val waiting = pendingSpeak
            pendingSpeak = null
            waiting?.third?.invoke(result(JSONObject()))
            val pending = speakDone
            speakDone = null
            tts?.stop()
            pending?.let { it(result(JSONObject())) }
            done(result(JSONObject()))
        }
    }
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
