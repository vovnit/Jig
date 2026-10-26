package dev.nitochkin.jig

import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageButton
import android.widget.PopupMenu
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
 * Root surface for the Jig runtime: owns the Views renderer and the JS runtime,
 * keeps the runtime's viewport, keyboard, back stack and appearance in sync, and
 * switches between bundled app specs.
 */
class MainActivity : ComponentActivity() {
    private data class BundledApp(val id: String, val name: String, val json: String)

    private lateinit var surface: JigLayout
    private lateinit var renderer: AndroidRenderer
    private lateinit var runtime: JigRuntime
    private lateinit var menuButton: ImageButton
    private var apps: List<BundledApp> = emptyList()
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        surface = JigLayout(this)
        setContentView(surface)

        renderer = AndroidRenderer(surface)
        runtime = JigRuntime(this, renderer)
        runtime.onTheme = ::applyTheme
        // System back pops a runtime screen while there is one to pop; otherwise Android handles it.
        renderer.onNavDepth = { depth -> back.isEnabled = depth > 1 }
        onBackPressedDispatcher.addCallback(this, back)
        apps = loadBundledApps()

        setUpMenuButton()
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
        val lastId = getSharedPreferences("jig", MODE_PRIVATE).getString("jig.lastApp", null)
        (apps.firstOrNull { it.id == lastId } ?: apps.firstOrNull())?.let(::open)
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
        positionMenuButton()
    }

    private fun applyTheme(theme: JigRuntime.Theme) {
        renderer.isDark = theme.isDark
        theme.colors["accent"]?.let(AndroidRenderer::color)?.let { renderer.accentColor = it }
        theme.colors["background"]?.let(AndroidRenderer::color)?.let {
            window.decorView.setBackgroundColor(it)
            renderer.screenBackground = it
        }
        theme.colors["muted"]?.let(AndroidRenderer::color)?.let { menuButton.imageTintList = ColorStateList.valueOf(it) }
        WindowCompat.getInsetsController(window, surface).apply {
            isAppearanceLightStatusBars = !theme.isDark
            isAppearanceLightNavigationBars = !theme.isDark
        }
    }

    private fun open(app: BundledApp) {
        runtime.load(app.json)
        getSharedPreferences("jig", MODE_PRIVATE).edit().putString("jig.lastApp", app.id).apply()
        menuButton.bringToFront()
    }

    // ---------- Keyboard: tapping outside a field dismisses it ----------

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_DOWN) {
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

    // ---------- App switcher ----------

    private fun setUpMenuButton() {
        menuButton = ImageButton(this).apply {
            setImageResource(R.drawable.ic_apps)
            background = null
            contentDescription = "Switch app"
            setOnClickListener { v ->
                PopupMenu(this@MainActivity, v).apply {
                    apps.forEachIndexed { i, app -> menu.add(0, i, i, app.name) }
                    setOnMenuItemClickListener { item ->
                        open(apps[item.itemId])
                        true
                    }
                }.show()
            }
        }
        surface.addView(menuButton, FrameParams())
    }

    private fun positionMenuButton() {
        val d = renderer.density
        val size = (44 * d).roundToInt()
        val p = menuButton.layoutParams as FrameParams
        p.width = size
        p.height = size
        p.x = surface.width - insets.right - size - (12 * d).roundToInt()
        p.y = insets.top + (4 * d).roundToInt()
        menuButton.requestLayout()
        menuButton.visibility = View.VISIBLE
    }

    private fun loadBundledApps(): List<BundledApp> =
        (assets.list("runtime") ?: emptyArray()).filter { it.endsWith(".json") }.mapNotNull { file ->
            val json = assets.open("runtime/$file").bufferedReader().use { it.readText() }
            val spec = runCatching { JSONObject(json) }.getOrNull() ?: return@mapNotNull null
            if (!spec.has("screens")) return@mapNotNull null
            val id = spec.optString("id").ifEmpty { return@mapNotNull null }
            BundledApp(id, spec.optString("name", id), json)
        }.sortedBy { it.name }
}
