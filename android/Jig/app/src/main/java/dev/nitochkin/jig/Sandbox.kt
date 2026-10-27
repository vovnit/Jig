package dev.nitochkin.jig

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream

/**
 * The host side of custom code (`docs/custom-code.md`): one hidden WebView per
 * app id, kept while the app is open and dropped when it closes (or after 2
 * minutes unused).
 *
 * The view is created with the application context and never attached to a
 * window: evaluation and the message port work once the page loads, so no view
 * hierarchy is needed (and nothing holds the activity). Each script's `code`
 * (its libraries, then its source) is evaluated once per `{script, hash}` in a
 * wrapper with its own `exports`, kept in a page-global map by script name.
 */
object Sandbox {
    private const val TAG = "Jig"
    private const val IDLE_MS = 120_000L
    private const val MAX_RESULT_BYTES = 2 * 1024 * 1024
    private const val DEFAULT_TIMEOUT_MS = 5_000L

    private val main = Handler(Looper.getMainLooper())
    private var nextId = 1
    private val sandboxes = mutableMapOf<String, Entry>()

    private class Pending(val kind: String, val done: (String) -> Unit, val timeout: Runnable)

    private class Entry(
        val app: String,
        var allow: Set<String>,
        var view: WebView?,
        var port: WebMessagePort?,
        var ready: Boolean,
        val loaded: MutableMap<String, String>,
        val pending: MutableMap<Int, Pending>,
        var idle: Runnable?,
        val waiting: ArrayDeque<() -> Unit>,
        var needsReload: Boolean,
    )

    fun run(args: JSONObject, done: (String) -> Unit) {
        main.post { callOnMain(args, done, render = false) }
    }

    fun render(args: JSONObject, done: (String) -> Unit) {
        main.post { callOnMain(args, done, render = true) }
    }

    /** Drops the app's sandbox; in-flight calls answer "Sandbox closed" at once. */
    fun close(args: JSONObject, done: (String) -> Unit) {
        val app = args.optString("app")
        main.post {
            if (app.isNotEmpty()) destroy(app)
            done(Services.result(JSONObject()))
        }
    }

    // ---------- Calls (main thread) ----------

    private fun callOnMain(args: JSONObject, done: (String) -> Unit, render: Boolean) {
        val app = args.optString("app")
        val script = args.optString("script")
        val name = if (render) args.optString("element") else args.optString("fn")
        if (app.isEmpty()) return done(Services.error("A script needs an app"))
        if (script.isEmpty()) return done(Services.error("A script needs a name"))
        if (name.isEmpty()) return done(Services.error(if (render) "An element needs a name" else "A function needs a name"))
        val input = (if (render) args.optJSONObject("props") else args.optJSONObject("args"))?.toString() ?: "{}"
        val code = args.optString("code", "")
        val hash = args.optString("hash", "")
        val allow = allowHosts(args)
        val timeoutMs = args.optLong("timeoutMs", DEFAULT_TIMEOUT_MS).let { if (it <= 0) DEFAULT_TIMEOUT_MS else it }

        val box = sandboxes[app] ?: (createEntry(app, allow) ?: return done(Services.error("No app context")))
        if (box.allow != allow) {
            // The page's CSP names exactly the allowed hosts, so a new list rebuilds it.
            box.allow = allow
            box.loaded.clear()
            box.needsReload = false
            loadPage(box)
        } else if (box.needsReload) {
            // A broken script load left the page suspect; rebuild it before the next call.
            box.needsReload = false
            box.loaded.clear()
            loadPage(box)
        }
        box.idle?.let { main.removeCallbacks(it) }
        box.idle = null

        val id = nextId++
        val kind = if (render) "render" else "run"
        val timeout = Runnable { onTimeout(box, id) }
        box.pending[id] = Pending(kind, done, timeout)
        main.postDelayed(timeout, timeoutMs)
        val op: () -> Unit = { startCall(box, id, script, name, input, code, hash, render) }
        if (box.ready && box.view != null) op() else box.waiting.addLast(op)
    }

    private fun startCall(entry: Entry, id: Int, script: String, name: String, input: String, code: String, hash: String, render: Boolean) {
        if (sandboxes[entry.app] !== entry || !entry.pending.containsKey(id)) return
        val view = entry.view
        if (view == null || !entry.ready) {
            entry.waiting.addLast { startCall(entry, id, script, name, input, code, hash, render) }
            return
        }
        if (hash.isNotEmpty() && entry.loaded[script] == hash) {
            invoke(entry, id, view, script, name, input, render)
            return
        }
        if (hash.isEmpty() && entry.loaded.containsKey(script) && code.isEmpty()) {
            invoke(entry, id, view, script, name, input, render)
            return
        }
        if (code.isEmpty()) return failPending(entry, id, "No code to load")
        view.evaluateJavascript(loadExpression(script, code)) { result ->
            if (sandboxes[entry.app] !== entry || !entry.pending.containsKey(id)) return@evaluateJavascript
            val message = loadError(result)
            if (message != null) {
                if (message == "Couldn't load the script") entry.needsReload = true
                return@evaluateJavascript failPending(entry, id, message)
            }
            entry.loaded[script] = hash
            invoke(entry, id, view, script, name, input, render)
        }
    }

    private fun invoke(entry: Entry, id: Int, view: WebView, script: String, name: String, input: String, render: Boolean) {
        val call = if (render) "__callRender(" else "__callRun("
        view.evaluateJavascript(call + id + "," + JSONObject.quote(script) + "," + JSONObject.quote(name) + "," + JSONObject.quote(input) + ")", null)
    }

    /** The page answers through the message port; a late reply (past its timeout) is dropped. */
    private fun onMessage(app: String, raw: String?) {
        if (raw == null) return
        val entry = sandboxes[app] ?: return
        val reply = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val pending = entry.pending.remove(reply.optInt("id", -1)) ?: return
        main.removeCallbacks(pending.timeout)
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_RESULT_BYTES) {
            pending.done(Services.error("Result too large"))
            scheduleIdle(entry)
            return
        }
        if (!reply.isNull("error")) {
            pending.done(Services.error(reply.optString("error", "Failed").ifEmpty { "Failed" }))
            scheduleIdle(entry)
            return
        }
        val value: Any = if (reply.isNull("value")) JSONObject.NULL else reply.opt("value") ?: JSONObject.NULL
        pending.done(Services.result(JSONObject().put(if (pending.kind == "render") "tree" else "value", value)))
        scheduleIdle(entry)
    }

    private fun failPending(entry: Entry, id: Int, message: String) {
        val pending = entry.pending.remove(id) ?: return
        main.removeCallbacks(pending.timeout)
        pending.done(Services.error(message))
        scheduleIdle(entry)
    }

    /** No answer within `timeoutMs`: fail the call, destroy the view, recreate on next use. */
    private fun onTimeout(entry: Entry, id: Int) {
        val pending = entry.pending.remove(id) ?: return
        pending.done(Services.error("Timed out"))
        val rest = entry.pending.values.toList()
        entry.pending.clear()
        rest.forEach {
            main.removeCallbacks(it.timeout)
            it.done(Services.error("Timed out"))
        }
        destroy(entry.app)
    }

    // ---------- Lifetime (main thread) ----------

    private fun scheduleIdle(entry: Entry) {
        if (sandboxes[entry.app] !== entry) return
        entry.idle?.let { main.removeCallbacks(it) }
        if (entry.pending.isNotEmpty()) {
            entry.idle = null
            return
        }
        val idle = Runnable {
            if (entry.pending.isEmpty() && sandboxes[entry.app] === entry) destroy(entry.app)
        }
        entry.idle = idle
        main.postDelayed(idle, IDLE_MS)
    }

    private fun destroy(app: String) {
        val entry = sandboxes.remove(app) ?: return
        entry.idle?.let { main.removeCallbacks(it) }
        entry.idle = null
        val rest = entry.pending.values.toList()
        entry.pending.clear()
        rest.forEach {
            main.removeCallbacks(it.timeout)
            it.done(Services.error("Sandbox closed"))
        }
        entry.waiting.clear()
        entry.view?.let { view ->
            runCatching { view.stopLoading() }
            runCatching { view.destroy() }
        }
        entry.view = null
        entry.port?.let { runCatching { it.close() } }
        entry.port = null
        entry.ready = false
    }

    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun createEntry(app: String, allow: Set<String>): Entry? {
        val base = Services.appContext?.applicationContext ?: Services.appContext ?: return null
        val entry = Entry(app, allow, null, null, false, mutableMapOf(), mutableMapOf(), null, ArrayDeque(), false)
        val view = try {
            WebView(base).apply {
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                webViewClient = SandboxClient(app, allow.toSet())
                webChromeClient = object : WebChromeClient() {
                    override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
                        Log.i(TAG, "script[$app] ${message?.message()}")
                        return true
                    }
                }
            }
        } catch (e: Exception) {
            return null
        }
        entry.view = view
        sandboxes[app] = entry
        loadPage(entry)
        return entry
    }

    private fun loadPage(entry: Entry) {
        entry.ready = false
        entry.port?.let { runCatching { it.close() } }
        entry.port = null
        // The interceptor keeps its own snapshot, so swap it with the page it guards.
        entry.view?.webViewClient = SandboxClient(entry.app, entry.allow.toSet())
        entry.view?.loadDataWithBaseURL("about:blank", buildHtml(entry.allow), "text/html", "utf-8", null)
    }

    private class SandboxClient(private val app: String, private val allow: Set<String>) : WebViewClient() {
        // No navigation at all, not even the blank page.
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true

        @Suppress("DEPRECATION", "OverridingDeprecatedMember")
        override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = true

        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
            val url = request?.url ?: return null
            return if (isAllowed(allow, url.scheme, url.host)) null else denied()
        }

        @Suppress("DEPRECATION", "OverridingDeprecatedMember")
        override fun shouldInterceptRequest(view: WebView?, url: String?): WebResourceResponse? {
            if (url == null) return null
            val parsed = Uri.parse(url)
            return if (isAllowed(allow, parsed.scheme, parsed.host)) null else denied()
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            val entry = Sandbox.sandboxes[app] ?: return
            if (entry.view !== view || view == null) return
            try {
                val channel = view.createWebMessageChannel()
                channel[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(port: WebMessagePort?, message: WebMessage?) {
                        Sandbox.onMessage(app, message?.data)
                    }
                })
                entry.port?.let { runCatching { it.close() } }
                entry.port = channel[0]
                view.postWebMessage(WebMessage("", arrayOf(channel[1])), Uri.EMPTY)
            } catch (e: Exception) {
                Log.w(Sandbox.TAG, "script[$app] no message channel: ${e.message}")
                // The page isn't ready: fail what was queued and drop the sandbox.
                val message = e.message?.takeIf { it.isNotEmpty() } ?: "Failed to create message channel"
                val rest = entry.pending.values.toList()
                entry.pending.clear()
                entry.waiting.clear()
                rest.forEach {
                    Sandbox.main.removeCallbacks(it.timeout)
                    it.done(Services.error(message))
                }
                Sandbox.destroy(app)
                return
            }
            entry.ready = true
            while (entry.waiting.isNotEmpty()) entry.waiting.removeFirst().invoke()
        }

        /** Only the page itself (no host) and the allowed https hosts load; the rest get an empty 403. */
        private fun isAllowed(allow: Set<String>, scheme: String?, host: String?): Boolean {
            if (host == null) return true
            if (scheme?.lowercase() != "https") return false
            return allow.contains(host.lowercase())
        }

        private fun denied(): WebResourceResponse = WebResourceResponse(
            "text/plain", "utf-8", 403, "Forbidden", mutableMapOf(), ByteArrayInputStream(ByteArray(0)),
        )
    }

    // ---------- Page ----------

    private fun allowHosts(args: JSONObject): Set<String> {
        val found = mutableSetOf<String>()
        val list = args.optJSONObject("network")?.optJSONArray("allow") ?: return found
        for (i in 0 until list.length()) {
            val host = list.optString(i).trim().lowercase()
            if (host.isNotEmpty() && host.all { it.isLetterOrDigit() || it == '.' || it == '-' }) found.add(host)
        }
        return found
    }

    private fun buildHtml(allow: Set<String>): String {
        val connect = if (allow.isEmpty()) "'none'" else allow.sorted().joinToString(" ") { "https://$it" }
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src " + connect + "\">" +
            "<script>" + PAGE_JS + "</script></head><body></body></html>"
    }

    private fun loadExpression(script: String, code: String): String =
        "__loadScript(" + JSONObject.quote(script) + "," + JSONObject.quote(code) + ")"

    /** `__loadScript` returns "" on success, the error message on failure. */
    private fun loadError(result: String?): String? {
        if (result == null || result == "null") return "Couldn't load the script"
        val value = runCatching { JSONTokener(result).nextValue() }.getOrNull() ?: return "Couldn't load the script"
        if (value is String) return if (value.isNotEmpty()) value else null
        return "Couldn't load the script"
    }

    // `evaluateJavascript` doesn't await Promises, so calls post their
    // result back through a message port the host hands the page at load.
    // Replies arriving before the port do wait in `__pending`, so a call
    // evaluated right after load still answers once the port lands.
    private const val PAGE_JS =
            "var __scripts = {};\n" +
                "var __port = null;\n" +
                "var __pending = [];\n" +
                "function __reply(msg) {\n" +
                "  var s;\n" +
                "  try { s = JSON.stringify(msg); }\n" +
                "  catch (e) { s = JSON.stringify({id: msg.id, error: String((e && e.message) || e)}); }\n" +
                "  if (__port) { try { __port.postMessage(s); return; } catch (e) {} }\n" +
                "  __pending.push(s);\n" +
                "}\n" +
                "window.addEventListener('message', function (e) {\n" +
                "  var p = e.ports && e.ports[0];\n" +
                "  if (!p) return;\n" +
                "  __port = p;\n" +
                "  while (__pending.length) { var s = __pending.shift(); try { __port.postMessage(s); } catch (err) { __pending.unshift(s); break; } }\n" +
                "});\n" +
                "function __loadScript(name, code) {\n" +
                "  try {\n" +
                "    var exports = {};\n" +
                "    (new Function('exports', code))(exports);\n" +
                "    __scripts[name] = exports;\n" +
                "    return '';\n" +
                "  } catch (e) { return (e && e.message) || String(e); }\n" +
                "}\n" +
                "function __sendValue(id, v) {\n" +
                "  if (v === undefined) v = null;\n" +
                "  var probe;\n" +
                "  try { probe = JSON.stringify(v); }\n" +
                "  catch (e) { __reply({id: id, error: (e && e.message) || String(e)}); return; }\n" +
                "  if (probe === undefined) { __reply({id: id, error: 'Not serializable'}); return; }\n" +
                "  __reply({id: id, value: v});\n" +
                "}\n" +
                "function __callRun(id, script, fn, argsJson) {\n" +
                "  var table = __scripts[script];\n" +
                "  var f = table && table[fn];\n" +
                "  if (typeof f !== 'function') { __reply({id: id, error: 'No such function: ' + script + '.' + fn}); return; }\n" +
                "  var args = {};\n" +
                "  try { args = JSON.parse(argsJson); } catch (e) {}\n" +
                "  var r;\n" +
                "  try { r = f(args); }\n" +
                "  catch (e) { __reply({id: id, error: (e && e.message) || String(e)}); return; }\n" +
                "  Promise.resolve(r).then(\n" +
                "    function (v) { __sendValue(id, v); },\n" +
                "    function (e) { __reply({id: id, error: (e && e.message) || String(e)}); });\n" +
                "}\n" +
                "function __callRender(id, script, element, propsJson) {\n" +
                "  var table = __scripts[script];\n" +
                "  var f = table && table[element];\n" +
                "  if (typeof f !== 'function') { __reply({id: id, error: 'No such element: ' + script + '.' + element}); return; }\n" +
                "  var props = {};\n" +
                "  try { props = JSON.parse(propsJson); } catch (e) {}\n" +
                "  var r;\n" +
                "  try { r = f(props); }\n" +
                "  catch (e) { __reply({id: id, error: (e && e.message) || String(e)}); return; }\n" +
                "  Promise.resolve(r).then(\n" +
                "    function (v) { __sendValue(id, v); },\n" +
                "    function (e) { __reply({id: id, error: (e && e.message) || String(e)}); });\n" +
                "}\n"
}
