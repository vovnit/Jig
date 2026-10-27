package dev.nitochkin.jig

import android.content.res.Configuration
import android.graphics.Rect
import android.os.Bundle
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Root surface for the Jig runtime: owns the Views renderer and the JS runtime, keeps the
 * runtime's viewport, keyboard, back stack and appearance in sync, and starts the shell,
 * whose list of apps the bundled demo specs seed.
 */
class MainActivity : ComponentActivity() {
    private lateinit var surface: JigLayout
    private lateinit var renderer: AndroidRenderer
    private lateinit var runtime: JigRuntime
    private var insets = Rect()
    private var lastViewport: List<Double>? = null

    /** System back pops a runtime screen; with predictive back the screen follows the gesture. */
    private val back = object : OnBackPressedCallback(false) {
        private var interactive = false

        override fun handleOnBackStarted(backEvent: BackEventCompat) {
            interactive = renderer.beginInteractiveBack()
        }

        override fun handleOnBackProgressed(backEvent: BackEventCompat) {
            if (interactive) renderer.updateInteractiveBack(backEvent.progress)
        }

        override fun handleOnBackCancelled() {
            if (interactive) renderer.endInteractiveBack(commit = false) {}
            interactive = false
        }

        override fun handleOnBackPressed() {
            if (interactive) renderer.endInteractiveBack(commit = true) { runtime.goBack() } else runtime.goBack()
            interactive = false
        }
    }

    private var permissionAnswer: ((Boolean) -> Unit)? = null
    private val permission = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { granted ->
        permissionAnswer?.invoke(granted)
        permissionAnswer = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The builder's voice input asks for the microphone when first used.
        Services.requestPermission = { name, answer ->
            runOnUiThread {
                if (checkSelfPermission(name) == android.content.pm.PackageManager.PERMISSION_GRANTED) answer(true)
                else {
                    permissionAnswer = answer
                    permission.launch(name)
                }
            }
        }
        enableEdgeToEdge()
        surface = JigLayout(this)
        setContentView(surface)

        renderer = AndroidRenderer(surface)
        runtime = JigRuntime(this, renderer)
        runtime.onTheme = ::applyTheme
        // System back pops a runtime screen while there is one to pop; otherwise Android handles it.
        renderer.onCanGoBack = { back.isEnabled = it }
        onBackPressedDispatcher.addCallback(this, back)

        ViewCompat.setOnApplyWindowInsetsListener(surface) { _, windowInsets ->
            val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            // The keyboard shrinks the app from below; scroll views then keep the focused field in view.
            insets = Rect(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            updateViewport()
            windowInsets
        }
        surface.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateViewport() }

        runtime.setColorScheme(isNight(resources.configuration))
        val (shell, seeds) = bundledSpecs()
        runtime.boot(shell, seeds)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        runtime.setColorScheme(isNight(newConfig))
    }

    override fun onDestroy() {
        runtime.destroy()
        super.onDestroy()
    }

    private fun isNight(config: Configuration) =
        config.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    private fun updateViewport() {
        val d = renderer.density.toDouble()
        val viewport = listOf(surface.width / d, surface.height / d, insets.top / d, insets.right / d, insets.bottom / d, insets.left / d)
        if (surface.width == 0 || viewport == lastViewport) return
        lastViewport = viewport
        runtime.setViewport(viewport[0], viewport[1], viewport[2], viewport[3], viewport[4], viewport[5])
    }

    private fun applyTheme(theme: JigRuntime.Theme) {
        renderer.isDark = theme.isDark
        theme.colors["accent"]?.let(AndroidRenderer::color)?.let { renderer.accentColor = it }
        theme.colors["background"]?.let(AndroidRenderer::color)?.let {
            window.decorView.setBackgroundColor(it)
            renderer.screenBackground = it
        }
        WindowCompat.getInsetsController(window, surface).apply {
            isAppearanceLightStatusBars = !theme.isDark
            isAppearanceLightNavigationBars = !theme.isDark
        }
    }

    // ---------- Keyboard: tapping outside a field dismisses it ----------

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_DOWN) {
            renderer.rows.onSurfaceDown(ev.rawX, ev.rawY)
            val focused = currentFocus
            if (focused is EditText) {
                val r = Rect()
                focused.getGlobalVisibleRect(r)
                if (!r.contains(ev.rawX.roundToInt(), ev.rawY.roundToInt())) {
                    focused.clearFocus()
                    getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(focused.windowToken, 0)
                }
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    // ---------- Specs ----------

    /** `shell.json`, and every other bundled spec (as a JSON array) for the shell's app list. */
    private fun bundledSpecs(): Pair<String, String> {
        val read = { file: String -> assets.open("runtime/$file").bufferedReader().use { it.readText() } }
        val seeds = (assets.list("runtime") ?: emptyArray()).sorted()
            .filter { it.endsWith(".json") && it != "shell.json" }
            .map(read)
            .filter { runCatching { JSONObject(it).has("screens") }.getOrDefault(false) }
        return read("shell.json") to seeds.joinToString(",", "[", "]")
    }
}
