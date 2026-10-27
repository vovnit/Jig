package dev.nitochkin.jig

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.net.Uri
import android.os.Bundle
import android.text.Layout
import android.text.TextPaint
import android.util.Base64
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.RemoteViews
import android.widget.TextView
import androidx.core.graphics.PathParser
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Home-screen widgets (Phase G): `widgets.set` draws each entry's light and dark
 * tree to a PNG with `Canvas`, one row per app widget in a catalog JSON, all under
 * `filesDir/widgets/`. Widgets can't run JS, so the provider below only shows the
 * PNG for the current time and color scheme, and a tap opens the app at `open`.
 */
object WidgetStore {
    const val TICK = "dev.nitochkin.jig.WIDGET_TICK"
    private const val PREFS = "jig.widgets"

    private val io = Executors.newSingleThreadExecutor()

    /** Widget sizes in points, as the core renders them (see `WIDGET_SIZES`). */
    private val sizes = mapOf("small" to (158 to 158), "medium" to (338 to 158), "large" to (338 to 354))

    /** Draws every entry of every widget to PNGs, answers `{}`, then refreshes placed widgets. */
    fun set(context: Context, args: JSONObject, done: (String) -> Unit) {
        // Bitmap drawing and file IO stay off the JS thread (dozens of PNGs per set).
        io.execute {
            try {
                applySet(context, args)
                done(Services.result(JSONObject()))
            } catch (e: Exception) {
                done(Services.error(e.message ?: "Couldn't save the widgets"))
            }
            refreshAll(context)
        }
    }

    private fun dir(context: Context): File = File(context.filesDir, "widgets").apply { mkdirs() }

    private fun catalogFile(context: Context) = File(dir(context), "catalog.json")

    /** One row per app widget: id, title, app, open, sizes and entry dates. */
    fun readCatalog(context: Context): ArrayList<JSONObject> {
        val raw = runCatching { catalogFile(context).readText() }.getOrNull() ?: return ArrayList()
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return ArrayList()
        return ArrayList((0 until array.length()).mapNotNull { array.optJSONObject(it) })
    }

    private fun saveCatalog(context: Context, rows: List<JSONObject>) {
        val array = JSONArray()
        rows.forEach { array.put(it) }
        runCatching { catalogFile(context).writeText(array.toString()) }
    }

    fun choiceKey(appWidgetId: Int) = "choice_$appWidgetId"

    fun choice(context: Context, appWidgetId: Int): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(choiceKey(appWidgetId), null)

    fun choose(context: Context, appWidgetId: Int, id: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(choiceKey(appWidgetId), id).apply()
    }

    fun forget(context: Context, appWidgetId: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(choiceKey(appWidgetId)).apply()
    }

    fun row(context: Context, id: String): JSONObject? =
        readCatalog(context).firstOrNull { it.optString("id") == id }

    private fun widgetId(app: String, name: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        return digest.digest("$app/$name".toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private fun applySet(context: Context, args: JSONObject) {
        val app = args.optString("app")
        val appName = args.optString("appName").takeIf { it.isNotEmpty() } ?: app
        val widgets = args.optJSONArray("widgets") ?: JSONArray()
        val rows = readCatalog(context)
        val previous = rows.filter { it.optString("app") == app }.map { it.optString("id") }
        rows.removeAll { it.optString("app") == app }
        // One row per app widget: a widget at several sizes shares its id (as on iOS).
        val merged = LinkedHashMap<String, JSONObject>()
        val kept = HashSet<String>()
        val density = context.resources.displayMetrics.density
        for (i in 0 until widgets.length()) {
            val w = widgets.optJSONObject(i) ?: continue
            val name = w.optString("name")
            val size = w.optString("size")
            val dims = sizes[size] ?: continue
            if (name.isEmpty()) continue
            val id = widgetId(app, name)
            kept.add(id)
            val row = merged.getOrPut(id) {
                JSONObject()
                    .put("id", id)
                    .put("title", "$appName: ${w.optString("title").takeIf { it.isNotEmpty() } ?: name}")
                    .put("app", app)
                    .put("open", w.optString("open"))
                    .put("sizes", JSONArray())
                    .put("dates", JSONArray())
            }
            addUnique(row.getJSONArray("sizes"), size)
            val entries = w.optJSONArray("entries") ?: JSONArray()
            val saved = JSONArray()
            for (j in 0 until entries.length()) {
                val e = entries.optJSONObject(j) ?: continue
                val date = e.optLong("date")
                addDate(row.getJSONArray("dates"), date)
                val record = JSONObject().put("date", date)
                for (theme in listOf("light", "dark")) {
                    val file = "$id-$size-$j-$theme.png"
                    drawEntry(context, e.optJSONObject(theme) ?: JSONObject(), dims.first, dims.second, density, theme == "dark", File(dir(context), file))
                    record.put(theme, file)
                }
                saved.put(record)
            }
            File(dir(context), "$id-$size.json").writeText(saved.toString())
        }
        // `widgets: []` (or a dropped widget) removes that app's rows and files.
        for (old in previous) {
            if (old !in kept) dir(context).listFiles()?.forEach { if (it.name.startsWith("$old-")) runCatching { it.delete() } }
        }
        rows.addAll(merged.values)
        saveCatalog(context, rows)
    }

    private fun addUnique(array: JSONArray, value: String) {
        for (i in 0 until array.length()) if (array.optString(i) == value) return
        array.put(value)
    }

    private fun addDate(array: JSONArray, date: Long) {
        val sorted = ((0 until array.length()).map { array.optLong(it) } + date).distinct().sorted()
        for (i in array.length() - 1 downTo 0) array.remove(i)
        sorted.forEach { array.put(it) }
    }

    /** Draws one entry tree to a PNG at the widget size in pixels (points × density). */
    private fun drawEntry(context: Context, node: JSONObject, widthPt: Int, heightPt: Int, density: Float, dark: Boolean, out: File) {
        val widthPx = (widthPt * density).roundToInt().coerceAtLeast(1)
        val heightPx = (heightPt * density).roundToInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(if (dark) Color.BLACK else Color.WHITE)
        drawNode(node, canvas, density, context)
        runCatching {
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        bitmap.recycle()
    }

    private fun frame(value: Any?, density: Float): RectF? {
        val parts = when (value) {
            is JSONObject -> listOf(value.optDouble("x"), value.optDouble("y"), value.optDouble("width"), value.optDouble("height"))
            is JSONArray -> (0 until 4).map { value.optDouble(it) }
            else -> return null
        }
        if (parts[2] <= 0 || parts[3] <= 0) return null
        return RectF(parts[0].toFloat() * density, parts[1].toFloat() * density, (parts[0] + parts[2]).toFloat() * density, (parts[1] + parts[3]).toFloat() * density)
    }

    private fun drawNode(node: JSONObject, canvas: Canvas, density: Float, context: Context) {
        val frame = frame(node.opt("frame"), density) ?: return
        val opacity = node.optDouble("opacity", 1.0).coerceIn(0.0, 1.0)
        if (opacity < 1) canvas.saveLayerAlpha(frame.left, frame.top, frame.right, frame.bottom, (opacity * 255).roundToInt())
        else canvas.save()
        val radius = node.optDouble("radius", 0.0).toFloat() * density
        AndroidRenderer.color(node.opt("background"))?.let {
            canvas.drawRoundRect(frame, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.FILL
                color = it
            })
        }
        val border = node.optDouble("borderWidth", 0.0).toFloat() * density
        if (border > 0) AndroidRenderer.color(node.opt("borderColor"))?.let {
            val inset = RectF(frame).apply { inset(border / 2, border / 2) }
            canvas.drawRoundRect(inset, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                strokeWidth = border
                color = it
            })
        }
        when (node.optString("kind")) {
            "text" -> drawText(node, frame, canvas, density)
            "shape" -> drawShape(node, frame, canvas)
            "image" -> drawImage(node, frame, canvas, context)
            else -> Unit
        }
        node.optJSONArray("children")?.let { children ->
            for (i in 0 until children.length()) children.optJSONObject(i)?.let { drawNode(it, canvas, density, context) }
        }
        canvas.restore()
    }

    /** Text with a StaticLayout, like the renderer's own text views. */
    private fun drawText(node: JSONObject, frame: RectF, canvas: Canvas, density: Float) {
        val text = node.optString("text")
        if (text.isEmpty()) return
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
        TextStyle.configure(paint, node.optDouble("fontSize", 17.0), node.optInt("fontWeight", 400), density, node.optString("fontFamily") == "mono")
        paint.color = AndroidRenderer.color(node.opt("color")) ?: Color.BLACK
        val align = when (node.optString("align")) {
            "center" -> Layout.Alignment.ALIGN_CENTER
            "right", "end" -> Layout.Alignment.ALIGN_OPPOSITE
            else -> Layout.Alignment.ALIGN_NORMAL
        }
        val layout = TextStyle.layout(text, paint, (node.optDouble("lineHeight", 22.0) * density).roundToInt(), frame.width().roundToInt().coerceAtLeast(1), align)
        canvas.save()
        canvas.translate(frame.left, frame.top)
        layout.draw(canvas)
        canvas.restore()
    }

    /** A shape node: SVG path data in a viewBox, scaled to fit the frame. */
    private fun drawShape(node: JSONObject, frame: RectF, canvas: Canvas) {
        val data = node.optString("path")
        if (data.isEmpty()) return
        val parts = node.optString("viewBox").split(' ', ',').mapNotNull { it.toFloatOrNull() }
        val box = if (parts.size == 4) RectF(parts[0], parts[1], parts[0] + parts[2], parts[1] + parts[3]) else RectF(0f, 0f, 24f, 24f)
        if (box.width() <= 0 || box.height() <= 0) return
        val scale = min(frame.width() / box.width(), frame.height() / box.height())
        if (!scale.isFinite() || scale <= 0) return
        val path = runCatching { PathParser.createPathFromPathData(data) }.getOrNull() ?: return
        val matrix = Matrix()
        matrix.setTranslate(-box.left, -box.top)
        matrix.postScale(scale, scale)
        matrix.postTranslate(frame.left + (frame.width() - box.width() * scale) / 2, frame.top + (frame.height() - box.height() * scale) / 2)
        val dst = Path()
        path.transform(matrix, dst)
        AndroidRenderer.color(node.opt("fill"))?.let {
            canvas.drawPath(dst, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.FILL
                color = it
            })
        }
        val stroke = AndroidRenderer.color(node.opt("stroke")) ?: return
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = node.optDouble("strokeWidth", 1.0).toFloat() * scale
            color = stroke
        }
        val start = node.optDouble("trimStart", 0.0)
        val end = node.optDouble("trimEnd", 1.0)
        if (start <= 0 && end >= 1) {
            canvas.drawPath(dst, paint)
            return
        }
        // Stroke trimming: draw only that fraction of the path.
        val measure = PathMeasure()
        val segment = Path()
        var total = 0f
        measure.setPath(dst, false)
        do total += measure.length while (measure.nextContour())
        measure.setPath(dst, false)
        var offset = 0f
        do {
            val len = measure.length
            val a = (start * total - offset).toFloat().coerceIn(0f, len)
            val b = (end * total - offset).toFloat().coerceIn(0f, len)
            if (b > a) measure.getSegment(a, b, segment, true)
            offset += len
        } while (measure.nextContour())
        canvas.drawPath(segment, paint)
    }

    /** Images from `data:` URLs or `jig-file:` sources, as the renderer loads them. */
    private fun drawImage(node: JSONObject, frame: RectF, canvas: Canvas, context: Context) {
        val src = node.optString("src")
        if (src.isEmpty()) return
        val bytes = when {
            src.startsWith("data:") -> runCatching { Base64.decode(src.substringAfter(','), Base64.DEFAULT) }.getOrNull()
            src.startsWith("jig-file:") -> {
                val rest = src.removePrefix("jig-file:")
                val slash = rest.indexOf('/')
                if (slash < 0) null else FileStore.read(context, rest.substring(0, slash), rest.substring(slash + 1))
            }
            else -> null
        } ?: return
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
        canvas.drawBitmap(bitmap, null, frame, Paint(Paint.FILTER_BITMAP_FLAG))
        bitmap.recycle()
    }

    /** Refreshes every placed widget, then schedules the next timeline update. */
    fun refreshAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val me = ComponentName(context, JigWidgetProvider::class.java)
        runCatching { manager.getAppWidgetIds(me) }.getOrNull()?.forEach { JigWidgetProvider.updateWidget(context, it) }
        scheduleNext(context)
    }

    /** The next entry date after now across placed widgets, via an inexact alarm. */
    fun scheduleNext(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val me = ComponentName(context, JigWidgetProvider::class.java)
        val ids = runCatching { manager.getAppWidgetIds(me) }.getOrNull() ?: return
        val now = System.currentTimeMillis()
        var next = Long.MAX_VALUE
        for (id in ids) {
            val chosen = choice(context, id) ?: continue
            val row = row(context, chosen) ?: continue
            val size = sizeFor(manager, id, row) ?: continue
            for (date in entryDates(context, row.optString("id"), size)) {
                if (date > now && date < next) next = date
            }
        }
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        if (next == Long.MAX_VALUE) alarms.cancel(tick(context))
        else runCatching { alarms.set(AlarmManager.RTC_WAKEUP, next, tick(context)) }
    }

    private fun tick(context: Context): PendingIntent =
        PendingIntent.getBroadcast(context, 0, Intent(context, JigWidgetProvider::class.java).setAction(TICK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** The widget size to show: the placed size when rendered, else any rendered one. */
    fun sizeFor(manager: AppWidgetManager, appWidgetId: Int, row: JSONObject): String? {
        val stored = row.optJSONArray("sizes") ?: return null
        val available = (0 until stored.length()).map { stored.optString(it) }
        if (available.isEmpty()) return null
        val options = manager.getAppWidgetOptions(appWidgetId)
        val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
        val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
        val want = if (minWidth >= 250 && minHeight >= 250) "large" else if (minWidth >= 250) "medium" else "small"
        return if (available.contains(want)) want else available.first()
    }

    fun entryDates(context: Context, id: String, size: String): List<Long> =
        entriesFile(context, id, size)?.let { file ->
            val items = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return emptyList()
            (0 until items.length()).mapNotNull { items.optJSONObject(it)?.optLong("date") }
        } ?: emptyList()

    fun entryFile(context: Context, id: String, size: String, date: Long, dark: Boolean): File? {
        val items = runCatching { JSONArray(entriesFile(context, id, size)?.readText() ?: return null) }.getOrNull() ?: return null
        var pick = items.optJSONObject(0) ?: return null
        for (i in 0 until items.length()) {
            val e = items.optJSONObject(i) ?: continue
            if (e.optLong("date") <= date) pick = e
        }
        return File(dir(context), pick.optString(if (dark) "dark" else "light").takeIf { it.isNotEmpty() } ?: return null)
    }

    private fun entriesFile(context: Context, id: String, size: String): File? =
        File(dir(context), "$id-$size.json").takeIf { it.isFile }

    fun isNight(context: Context): Boolean =
        context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
}

/** Shows the chosen app widget's PNG for the current entry, opening the app on tap. */
class JigWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { updateWidget(context, it) }
        WidgetStore.scheduleNext(context)
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        ids.forEach { WidgetStore.forget(context, it) }
        WidgetStore.scheduleNext(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == WidgetStore.TICK) WidgetStore.refreshAll(context)
        else if (intent.action == Intent.ACTION_BOOT_COMPLETED) WidgetStore.scheduleNext(context)
    }

    companion object {
        fun updateWidget(context: Context, appWidgetId: Int) {
            val manager = AppWidgetManager.getInstance(context)
            val views = RemoteViews(context.packageName, R.layout.widget_jig)
            val row = WidgetStore.choice(context, appWidgetId)?.let { WidgetStore.row(context, it) }
            val open = Intent(context, MainActivity::class.java)
                .setData(Uri.parse("jig-widget:$appWidgetId"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val bitmap = row?.let {
                open.putExtra("app", it.optString("app")).putExtra("open", it.optString("open"))
                val size = WidgetStore.sizeFor(manager, appWidgetId, it) ?: return@let null
                val file = WidgetStore.entryFile(context, it.optString("id"), size, System.currentTimeMillis(), WidgetStore.isNight(context))
                file?.takeIf { f -> f.isFile }?.let { f -> BitmapFactory.decodeFile(f.absolutePath) }
            }
            if (bitmap != null) views.setImageViewBitmap(R.id.widget_image, bitmap)
            else views.setImageViewResource(R.id.widget_image, android.R.color.transparent)
            views.setOnClickPendingIntent(R.id.widget_image, PendingIntent.getActivity(context, appWidgetId, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            runCatching { manager.updateAppWidget(appWidgetId, views) }
        }
    }
}

/** Lists the catalog rows to choose which app widget a placed widget shows. */
class WidgetConfigActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val appWidgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        val rows = WidgetStore.readCatalog(this)
        // With one row, choose it without asking.
        if (rows.size == 1) {
            choose(appWidgetId, rows[0].optString("id"))
            return
        }
        if (rows.isEmpty()) {
            val text = TextView(this).apply {
                setText(R.string.widget_empty)
                gravity = android.view.Gravity.CENTER
            }
            setContentView(text)
            return
        }
        val list = ListView(this)
        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, rows.map { it.optString("title") })
        list.setOnItemClickListener { _, _, position, _ -> choose(appWidgetId, rows[position].optString("id")) }
        setContentView(list)
    }

    private fun choose(appWidgetId: Int, id: String) {
        WidgetStore.choose(this, appWidgetId, id)
        JigWidgetProvider.updateWidget(this, appWidgetId)
        WidgetStore.scheduleNext(this)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        finish()
    }
}
