package dev.nitochkin.jig

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import com.whl.quickjs.android.QuickJSLoader
import com.whl.quickjs.wrapper.JSCallFunction
import com.whl.quickjs.wrapper.QuickJSContext
import org.json.JSONObject

/**
 * Runs the shared runtime (`jig-core.js`) in QuickJS and bridges it to the Android
 * Views renderer.
 *
 * Threading: JS runs on its own thread (a QuickJS context is bound to the thread
 * that created it), Views on the main thread. Ops cross to main as one JSON string
 * per frame; events and viewport changes cross to JS asynchronously. Text is
 * measured right on the JS thread with StaticLayout, so layout never waits on main.
 * SQLite also runs on the JS thread: the runtime saves at the end of a frame, after
 * the ops are sent.
 */
class JigRuntime(context: Context, private val renderer: AndroidRenderer, private val demo: Boolean = false) {
    data class Theme(val colors: Map<String, String>, val isDark: Boolean)

    /** Called on main after a load or color scheme change. */
    var onTheme: ((Theme) -> Unit)? = null

    private val appContext = context.applicationContext
    private val thread = HandlerThread("jig-js", Process.THREAD_PRIORITY_DISPLAY).apply { start() }
    private val js = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private lateinit var qjs: QuickJSContext
    private var frameRequested = false

    init {
        val toggle = renderer.toggleSize()
        val slider = renderer.sliderSize()
        val timePicker = renderer.timePickerSize()
        js.post { setUp(toggle, slider, timePicker) }
        renderer.dispatch = { id, name, payload -> dispatch(id, name, payload) }
    }

    // ---------- API (call from main) ----------

    /** Starts the shell; [seedsJson] is an array of bundled app specs for its list. [demoJson] carries a scripted take in demo mode. */
    fun boot(shellJson: String, seedsJson: String, demoJson: String = "") {
        js.post {
            call("__jigBoot", shellJson, seedsJson, demoJson)
            publishTheme()
        }
    }

    fun setColorScheme(dark: Boolean) {
        js.post {
            call("__jigSetColorScheme", if (dark) "dark" else "light")
            publishTheme()
        }
    }

    /** Sizes in dp, as the runtime lays out in points. */
    fun setViewport(width: Double, height: Double, top: Double, right: Double, bottom: Double, left: Double) {
        js.post { call("__jigSetViewport", width, height, top, right, bottom, left) }
    }

    fun dispatch(id: Int, name: String, payload: JSONObject = JSONObject()) {
        val json = payload.toString()
        js.post { call("__jigDispatch", id, name, json) }
    }

    /** Pops one screen (system back). */
    fun open(app: String, screen: String) { js.post { call("__jigOpen", app, screen) } }

    fun goBack() {
        js.post { call("__jigBack") }
    }

    fun destroy() {
        js.post {
            qjs.destroy()
            thread.quitSafely()
        }
    }

    // ---------- Setup (JS thread) ----------

    private fun setUp(toggle: Pair<Double, Double>, slider: Pair<Double, Double>, timePicker: Pair<Double, Double>) {
        QuickJSLoader.init()
        qjs = QuickJSContext.create()
        installNative(toggle, slider, timePicker)
        evaluateAsset("runtime/jig-core.js")
        // Shared with the iOS host: adapts the runtime's Host interface to `__native`.
        evaluateAsset("runtime/jig-host.js")
    }

    private fun evaluateAsset(path: String) {
        val source = try {
            appContext.assets.open(path).bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            throw IllegalStateException("$path is missing from the app assets. Run `npm run build:native` in the repo root.", e)
        }
        qjs.evaluate(source, path)
    }

    private fun call(function: String, vararg args: Any?): Any? = try {
        val fn = qjs.globalObject.getJSFunction(function)
        val result = fn.call(*args)
        fn.release()
        result
    } catch (e: Exception) {
        Log.e(TAG, "JS exception in $function: ${e.message}")
        null
    }

    private fun publishTheme() {
        val json = call("__jigTheme") as? String ?: return
        val obj = JSONObject(json)
        val colors = obj.getJSONObject("colors").let { c -> c.keys().asSequence().associateWith { c.getString(it) } }
        val theme = Theme(colors, obj.optBoolean("dark"))
        main.post { onTheme?.invoke(theme) }
    }

    private fun installNative(toggle: Pair<Double, Double>, slider: Pair<Double, Double>, timePicker: Pair<Double, Double>) {
        val native = qjs.createNewJSObject()
        // In demo mode a separate database, deleted first so the take starts from the
        // seeded state and never touches the user's apps.
        val dbName = if (demo) "jig-demo.sqlite" else "jig.sqlite"
        if (demo) appContext.deleteDatabase(dbName)
        val database = SqlDatabase(appContext, dbName)
        val secrets = SecretStore(appContext)

        native.setProperty("apply", JSCallFunction { args ->
            val json = args[0] as String
            main.post { renderer.apply(json) }
            null
        })
        native.setProperty("measure", JSCallFunction { args ->
            // The style travels as JSON so spans reach measurement too.
            val style = runCatching { JSONObject(args[1] as String) }.getOrElse { JSONObject() }
            val size = TextStyle.measure(
                text = args[0] as String,
                style = style,
                maxWidth = (args[2] as Number).toDouble(),
                density = renderer.density,
            )
            pair(size.first, size.second)
        })
        native.setProperty("measureControl", JSCallFunction { args ->
            when (args[0]) {
                "toggle" -> pair(toggle.first, toggle.second)
                "slider" -> pair(slider.first, slider.second)
                "timePicker" -> pair(timePicker.first, timePicker.second)
                else -> pair(0.0, 0.0)
            }
        })
        native.setProperty("requestFrame", JSCallFunction {
            main.post(::scheduleFrame)
            null
        })
        native.setProperty("sqlQuery", JSCallFunction { args -> database.query(args[0] as String, args[1] as String) })
        native.setProperty("sqlExec", JSCallFunction { args -> database.exec(args[0] as String) })
        native.setProperty("secretGet", JSCallFunction { args -> secrets.get(args[0] as String, args[1] as String) })
        native.setProperty("secretSet", JSCallFunction { args -> secrets.set(args[0] as String, args[1] as String, args[2] as String) })
        native.setProperty("secretDelete", JSCallFunction { args -> secrets.delete(args[0] as String, args[1] as String) })
        native.setProperty("secretClear", JSCallFunction { args -> secrets.clear(args[0] as String) })
        native.setProperty("call", JSCallFunction { args ->
            val id = (args[2] as Number).toInt()
            val resolve: (String) -> Unit = { json -> js.post { call("__jigResolve", id, json) } }
            val progress: (String) -> Unit = { json -> js.post { call("__jigProgress", id, json) } }
            if (args[0] == "screenshot") {
                // A PNG of a node's view, drawn by the renderer on main.
                val node = runCatching { JSONObject(args[1] as String).getInt("id") }.getOrDefault(0)
                main.post {
                    val png = renderer.snapshot(node)
                    resolve(if (png != null) Services.result(JSONObject().put("data", png)) else Services.error("No view to take a picture of"))
                }
            } else Services.handle(args[0] as String, args[1] as String, resolve, progress)
            null
        })
        // A timer for the runtime (the clock's ticks): QuickJS has no setTimeout here.
        native.setProperty("after", JSCallFunction { args ->
            val id = (args[1] as Number).toInt()
            js.postDelayed({ call("__jigTimer", id) }, (args[0] as Number).toLong())
            null
        })
        native.setProperty("now", JSCallFunction { SystemClock.uptimeMillis().toDouble() })
        native.setProperty("log", JSCallFunction { args ->
            // Info and below ride logcat as info, so the record script sees the demo lines.
            if (args[0] == "error") Log.e(TAG, "${args[0]}: ${args[1]}")
            else if (args[0] == "warn") Log.w(TAG, "${args[0]}: ${args[1]}")
            else Log.i(TAG, "${args[0]}: ${args[1]}")
            null
        })
        qjs.globalObject.setProperty("__native", native)
        native.release()
    }

    private fun pair(a: Double, b: Double) = qjs.createNewJSArray().apply {
        set(a, 0)
        set(b, 1)
    }

    // ---------- Frames ----------

    private fun scheduleFrame() {
        if (frameRequested) return
        frameRequested = true
        Choreographer.getInstance().postFrameCallback {
            frameRequested = false
            js.post { call("__jigFrame") }
        }
    }

    companion object {
        private const val TAG = "Jig"
    }
}
