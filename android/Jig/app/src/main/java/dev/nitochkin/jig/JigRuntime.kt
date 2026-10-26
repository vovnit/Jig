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
class JigRuntime(context: Context, private val renderer: AndroidRenderer) {
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
        js.post { setUp(toggle) }
        renderer.dispatch = { id, name, payload -> dispatch(id, name, payload) }
    }

    // ---------- API (call from main) ----------

    fun load(specJson: String) {
        js.post {
            call("__jigLoad", specJson)
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

    private fun setUp(toggle: Pair<Double, Double>) {
        QuickJSLoader.init()
        qjs = QuickJSContext.create()
        installNative(toggle)
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

    private fun installNative(toggle: Pair<Double, Double>) {
        val native = qjs.createNewJSObject()
        val database = SqlDatabase(appContext)

        native.setProperty("apply", JSCallFunction { args ->
            val json = args[0] as String
            val navDepth = (args.getOrNull(1) as? Number)?.toInt() ?: 1
            main.post { renderer.apply(json, navDepth) }
            null
        })
        native.setProperty("measure", JSCallFunction { args ->
            val size = TextStyle.measure(
                text = args[0] as String,
                fontSize = (args[1] as Number).toDouble(),
                fontWeight = (args[2] as Number).toInt(),
                lineHeight = (args[3] as Number).toDouble(),
                maxWidth = (args[4] as Number).toDouble(),
                density = renderer.density,
            )
            pair(size.first, size.second)
        })
        native.setProperty("measureControl", JSCallFunction { args ->
            if (args[0] == "toggle") pair(toggle.first, toggle.second) else pair(0.0, 0.0)
        })
        native.setProperty("requestFrame", JSCallFunction {
            main.post(::scheduleFrame)
            null
        })
        native.setProperty("sqlQuery", JSCallFunction { args -> database.query(args[0] as String, args[1] as String) })
        native.setProperty("sqlExec", JSCallFunction { args -> database.exec(args[0] as String) })
        native.setProperty("now", JSCallFunction { SystemClock.uptimeMillis().toDouble() })
        native.setProperty("log", JSCallFunction { args ->
            Log.w(TAG, "${args[0]}: ${args[1]}")
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
