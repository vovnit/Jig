package dev.nitochkin.jig

import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.Layout
import android.text.TextWatcher
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.Switch
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * The Android host: a "dumb" renderer that applies the runtime's ops. It creates
 * views by type, applies props and frames, and reports events by node id.
 * Units: the runtime lays out in dp; frames are converted to px here.
 */
class AndroidRenderer(private val surface: JigLayout) {
    var dispatch: ((Int, String, JSONObject) -> Unit)? = null
    var onNavDepth: ((Int) -> Unit)? = null
    var accentColor = 0xFF3B6EF6.toInt()
    var isDark = false
    val density = surface.resources.displayMetrics.density

    private class Node(val type: String, val view: View) {
        val props = HashMap<String, Any?>()
        val style = HashMap<String, Any?>()
        val background = GradientDrawable()
        var rippleRadius = -1f
        /** Set while the runtime writes a control's value, so it isn't reported back as a change. */
        var updating = false
    }

    private val nodes = HashMap<Int, Node>()
    private val context = surface.context
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    /** The text field being edited, kept visible above the keyboard. */
    private var focusedField: EditText? = null

    /** The platform switch's intrinsic size in dp, measured once on main. */
    fun toggleSize(): Pair<Double, Double> {
        val s = Switch(context)
        s.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        return s.measuredWidth / density.toDouble() to s.measuredHeight / density.toDouble()
    }

    // ---------- Ops ----------

    fun apply(json: String, navDepth: Int) {
        val ops = JSONArray(json)
        for (i in 0 until ops.length()) {
            val op = ops.getJSONArray(i)
            when (op.getString(0)) {
                "create" -> create(op.getInt(1), op.getString(2), op.getJSONObject(3))
                "update" -> update(op.getInt(1), op.getJSONObject(2))
                "insert" -> insert(op.getInt(1), op.getInt(2), op.getInt(3))
                "remove" -> remove(op.getInt(2))
                "frame" -> frame(op.getInt(1), op.getDouble(2), op.getDouble(3), op.getDouble(4), op.getDouble(5))
                "command" -> if (op.getString(2) == "focus") nodes[op.getInt(1)]?.view?.requestFocus()
            }
        }
        onNavDepth?.invoke(navDepth)
        // Layout may have moved the field (a new row, a viewport shrunk by the keyboard).
        surface.post { revealFocusedField() }
    }

    private fun create(id: Int, type: String, props: JSONObject) {
        val view = makeView(id, type)
        view.tag = id
        val node = Node(type, view)
        nodes[id] = node
        if (type == "root") {
            // Below any native chrome the host adds on the surface (the app switcher).
            for (i in surface.childCount - 1 downTo 0) if (surface.getChildAt(i).tag is Int) surface.removeViewAt(i)
            surface.addView(view, 0, FrameParams())
        }
        update(id, props)
    }

    private fun update(id: Int, props: JSONObject) {
        val node = nodes[id] ?: return
        for (k in props.keys()) {
            val v = props.get(k)
            if (k == "style" && v is JSONObject) {
                for (sk in v.keys()) {
                    val sv = v.get(sk)
                    if (sv == JSONObject.NULL) node.style.remove(sk) else node.style[sk] = sv
                }
            } else if (v == JSONObject.NULL) {
                node.props.remove(k)
            } else {
                node.props[k] = v
            }
        }
        render(node)
    }

    private fun insert(parentId: Int, childId: Int, index: Int) {
        val parent = nodes[parentId]?.view ?: return
        val child = nodes[childId]?.view ?: return
        val container = when (parent) {
            is JigScrollView -> parent.content
            is JigHScrollView -> parent.content
            is ViewGroup -> parent
            else -> return
        }
        if (child.parent === container && container.indexOfChild(child) == index) return
        (child.parent as? ViewGroup)?.removeView(child)
        container.addView(child, index.coerceAtMost(container.childCount), child.layoutParams as? FrameParams ?: FrameParams())
    }

    private fun remove(id: Int) {
        val view = nodes[id]?.view ?: return
        (view.parent as? ViewGroup)?.removeView(view)
        forget(view)
    }

    private fun forget(view: View) {
        val id = view.tag as? Int
        if (id != null && nodes[id]?.view === view) nodes.remove(id)
        if (view === focusedField) focusedField = null
        if (view is ViewGroup) for (i in 0 until view.childCount) forget(view.getChildAt(i))
    }

    private fun frame(id: Int, x: Double, y: Double, w: Double, h: Double) {
        val view = nodes[id]?.view ?: return
        // Round edges, not sizes, so neighbours never gap or overlap.
        val l = (x * density).roundToInt()
        val t = (y * density).roundToInt()
        val p = view.layoutParams as? FrameParams ?: FrameParams().also { view.layoutParams = it }
        val nw = ((x + w) * density).roundToInt() - l
        val nh = ((y + h) * density).roundToInt() - t
        if (p.x == l && p.y == t && p.width == nw && p.height == nh) return
        p.x = l
        p.y = t
        p.width = nw
        p.height = nh
        view.requestLayout()
    }

    // ---------- Views ----------

    private fun makeView(id: Int, type: String): View = when (type) {
        "text" -> JigTextView(context, isButton = false)
        "button" -> JigTextView(context, isButton = true).apply {
            isClickable = true
            setOnClickListener { dispatch?.invoke(id, "tap", JSONObject()) }
        }
        "textfield" -> EditText(context).apply {
            background = null
            includeFontPadding = false
            gravity = Gravity.CENTER_VERTICAL
            isSingleLine = true
            imeOptions = EditorInfo.IME_ACTION_DONE
            setOnEditorActionListener { _, _, _ ->
                dispatch?.invoke(id, "submit", JSONObject())
                true
            }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    if (nodes[id]?.updating == true) return
                    dispatch?.invoke(id, "change", JSONObject().put("value", s?.toString() ?: ""))
                }
            })
            setOnFocusChangeListener { v, hasFocus ->
                if (hasFocus) {
                    focusedField = v as EditText
                    v.post { revealFocusedField() }
                } else if (focusedField === v) focusedField = null
            }
        }
        "toggle" -> Switch(context).apply {
            setOnCheckedChangeListener { _, checked ->
                if (nodes[id]?.updating == true) return@setOnCheckedChangeListener
                dispatch?.invoke(id, "change", JSONObject().put("value", checked))
            }
        }
        "shape" -> JigShapeView(context)
        "image" -> ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        "scroll" -> JigScrollView(context)
        "hscroll" -> JigHScrollView(context)
        else -> JigLayout(context)
    }

    private fun render(node: Node) {
        val view = node.view
        val p = node.props
        val s = node.style

        // Box styling shared by every view type.
        val radius = (num(s["radius"]) ?: 0.0).toFloat() * density
        if (node.type != "toggle" && node.type != "textfield" || s.containsKey("background")) {
            val bg = node.background
            bg.setColor(color(s["background"]) ?: Color.TRANSPARENT)
            bg.cornerRadius = radius
            val border = num(s["borderWidth"]) ?: 0.0
            bg.setStroke((border * density).roundToInt(), color(s["borderColor"]) ?: Color.TRANSPARENT)
            view.background = bg
        }
        // Scroll views must always clip, or scrolled content draws over the header.
        view.clipToOutline = radius > 0 || node.type == "image"
        view.alpha = (num(s["opacity"]) ?: 1.0).toFloat()
        view.elevation = if (s["shadow"] == true || (s["shadow"] as? String)?.isNotEmpty() == true) 4 * density else 0f
        val pad = (s["padding"] as? JSONArray)?.let { a -> IntArray(4) { (a.optDouble(it) * density).roundToInt() } }
        if (pad != null) view.setPadding(pad[3], pad[0], pad[1], pad[2]) else if (node.type != "textfield") view.setPadding(0, 0, 0, 0)

        val tappable = p["tappable"] == true
        if (tappable && !view.hasOnClickListeners()) {
            view.setOnClickListener { dispatch?.invoke(view.tag as Int, "tap", JSONObject()) }
        }
        if ((tappable || node.type == "button") && node.rippleRadius != radius) {
            node.rippleRadius = radius
            view.foreground = RippleDrawable(
                ColorStateList.valueOf(if (isDark) 0x33FFFFFF else 0x1F000000),
                null,
                GradientDrawable().apply { cornerRadius = radius; setColor(Color.WHITE) },
            )
        }

        when (node.type) {
            "text", "button" -> {
                val t = view as JigTextView
                t.text = str(p[if (node.type == "button") "label" else "value"])
                t.setStyle(
                    fontSize = num(s["fontSize"]) ?: 17.0,
                    fontWeight = (num(s["fontWeight"]) ?: 400.0).toInt(),
                    lineHeight = num(s["lineHeight"]) ?: 22.0,
                    color = color(s["color"]) ?: Color.BLACK,
                    align = when (s["textAlign"]) {
                        "center" -> Layout.Alignment.ALIGN_CENTER
                        "right", "end" -> Layout.Alignment.ALIGN_OPPOSITE
                        else -> if (node.type == "button") Layout.Alignment.ALIGN_CENTER else Layout.Alignment.ALIGN_NORMAL
                    },
                )
            }
            "textfield" -> {
                val f = view as EditText
                if (pad != null) f.setPadding(pad[3], pad[0], pad[1], pad[2])
                f.setTextSize(TypedValue.COMPLEX_UNIT_PX, ((num(s["fontSize"]) ?: 17.0) * density).toFloat())
                f.typeface = TextStyle.typeface((num(s["fontWeight"]) ?: 400.0).toInt())
                val textColor = color(s["color"]) ?: Color.BLACK
                f.setTextColor(textColor)
                f.setHintTextColor((textColor and 0x00FFFFFF) or 0x80000000.toInt())
                f.highlightColor = (accentColor and 0x00FFFFFF) or 0x55000000
                f.hint = str(p["placeholder"])
                val type = if (p["keyboard"] == "number") InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
                else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                if (f.inputType != type) f.inputType = type
                // Native owns the text while the user types; only apply values from the runtime that differ.
                val value = str(p["value"])
                if (f.text.toString() != value) {
                    node.updating = true
                    f.setText(value)
                    f.setSelection(value.length)
                    node.updating = false
                }
            }
            "toggle" -> {
                val sw = view as Switch
                val off = if (isDark) 0xFF5A5F66.toInt() else 0xFFC8CCD2.toInt()
                val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
                sw.trackTintList = ColorStateList(states, intArrayOf(accentColor, off))
                sw.thumbTintList = ColorStateList(states, intArrayOf(Color.WHITE, Color.WHITE))
                val on = p["value"] == true
                if (sw.isChecked != on) {
                    node.updating = true
                    sw.isChecked = on
                    node.updating = false
                }
            }
            "shape" -> {
                val shape = view as JigShapeView
                shape.pathData = str(p["path"])
                shape.viewBox = viewBox(p["viewBox"])
                shape.fill = if (!p.containsKey("fill")) Color.BLACK else color(p["fill"])
                shape.stroke = color(p["stroke"])
                shape.strokeWidth = (num(p["strokeWidth"]) ?: 1.0).toFloat()
                shape.lineCap = when (p["lineCap"]) {
                    "round" -> Paint.Cap.ROUND
                    "square" -> Paint.Cap.SQUARE
                    else -> Paint.Cap.BUTT
                }
            }
            "image" -> loadImage(str(p["src"]), view as ImageView, view.tag as Int)
            "scroll", "hscroll" -> {
                val size = p["contentSize"] as? JSONArray ?: return
                val w = (size.getDouble(0) * density).roundToInt()
                val h = (size.getDouble(1) * density).roundToInt()
                if (view is JigScrollView) view.setContentSize(w, h) else (view as JigHScrollView).setContentSize(w, h)
            }
        }
    }

    // ---------- Keyboard ----------

    fun revealFocusedField() {
        val field = focusedField ?: return
        var v = field.parent
        while (v != null && v !is JigScrollView) v = v.parent
        val scroll = v as? JigScrollView ?: return
        val rect = android.graphics.Rect(0, 0, field.width, field.height)
        scroll.offsetDescendantRectToMyCoords(field, rect)
        val margin = (16 * density).roundToInt()
        val top = scroll.scrollY
        val bottom = top + scroll.height
        when {
            rect.bottom + margin > bottom -> scroll.smoothScrollTo(0, rect.bottom + margin - scroll.height)
            rect.top - margin < top -> scroll.smoothScrollTo(0, (rect.top - margin).coerceAtLeast(0))
        }
    }

    // ---------- Images ----------

    private val imageSources = HashMap<Int, String>()

    private fun loadImage(src: String, view: ImageView, id: Int) {
        if (imageSources[id] == src) return
        imageSources[id] = src
        view.setImageDrawable(null)
        io.execute {
            val bytes = runCatching {
                when {
                    src.startsWith("data:") -> Base64.decode(src.substringAfter(','), Base64.DEFAULT)
                    src.startsWith("https://") || src.startsWith("http://") -> URL(src).openStream().use { it.readBytes() }
                    else -> null
                }
            }.getOrNull() ?: return@execute
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@execute
            main.post {
                if (imageSources[id] != src) return@post
                view.setImageBitmap(bitmap)
                // Natural size in points (one image pixel per point), as on iOS.
                dispatch?.invoke(id, "load", JSONObject().put("width", bitmap.width).put("height", bitmap.height))
            }
        }
    }

    // ---------- Values ----------

    private fun viewBox(v: Any?): RectF {
        val parts = str(v).split(' ', ',').mapNotNull { it.toFloatOrNull() }
        return if (parts.size == 4) RectF(parts[0], parts[1], parts[0] + parts[2], parts[1] + parts[3]) else RectF(0f, 0f, 24f, 24f)
    }

    private fun str(v: Any?) = if (v == null || v == JSONObject.NULL) "" else v.toString()
    private fun num(v: Any?): Double? = (v as? Number)?.toDouble() ?: (v as? String)?.toDoubleOrNull()

    companion object {
        /** Parses the runtime's colors: `#rgb`, `#rrggbb`, `#rrggbbaa` (CSS order), `none`, `transparent`. */
        fun color(v: Any?): Int? {
            var s = (v as? String)?.trim()?.lowercase() ?: return null
            when (s) {
                "", "none" -> return null
                "transparent" -> return Color.TRANSPARENT
                "white" -> return Color.WHITE
                "black" -> return Color.BLACK
            }
            if (!s.startsWith("#")) return null
            s = s.substring(1)
            if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
            if (s.length == 6) s += "ff"
            if (s.length != 8) return null
            val rgba = s.toLongOrNull(16) ?: return null
            val a = (rgba and 0xff).toInt()
            return (a shl 24) or (rgba shr 8).toInt()
        }
    }
}
