package dev.nitochkin.jig

import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.text.Layout
import android.text.SpannableString
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.LineHeightSpan
import kotlin.math.ceil
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject

/**
 * One place that turns the runtime's text metrics into a StaticLayout, so
 * measurement (on the JS thread) and drawing (JigTextView) always agree.
 */
object TextStyle {
    private val paints = ThreadLocal.withInitial { TextPaint(Paint.ANTI_ALIAS_FLAG) }

    /** The system font, or its monospaced variant (`fontFamily: "mono"`, the builder's code view). */
    fun typeface(weight: Int, mono: Boolean = false): Typeface {
        val base = if (mono) Typeface.MONOSPACE else Typeface.DEFAULT
        return if (Build.VERSION.SDK_INT >= 28) Typeface.create(base, weight.coerceIn(1, 1000), false)
        else if (weight >= 600) Typeface.create(base, Typeface.BOLD) else base
    }

    fun configure(paint: TextPaint, fontSize: Double, fontWeight: Int, density: Float, mono: Boolean = false) {
        paint.textSize = (fontSize * density).toFloat()
        paint.typeface = typeface(fontWeight, mono)
    }

    /** One measured run: UTF-16 offsets into the text, like the runtime sends. */
    data class SpanRun(val start: Int, val end: Int, val bold: Boolean, val italic: Boolean)

    /** The text with its bold/italic runs applied, measured and drawn exactly alike. */
    fun spanned(text: String, runs: List<SpanRun>): SpannableString {
        val spanned = SpannableString(text)
        for (r in runs) {
            val s = r.start.coerceIn(0, text.length)
            val e = r.end.coerceIn(0, text.length)
            if (s >= e) continue
            if (r.bold) spanned.setSpan(android.text.style.StyleSpan(Typeface.BOLD), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (r.italic) spanned.setSpan(android.text.style.StyleSpan(Typeface.ITALIC), s, e, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return spanned
    }

    /** Styled runs from the runtime's `spans` style; malformed ranges measure nothing. */
    fun runsOf(spans: JSONArray?): List<SpanRun> {
        if (spans == null) return emptyList()
        return (0 until spans.length()).mapNotNull { i ->
            val o = spans.optJSONObject(i) ?: return@mapNotNull null
            SpanRun(o.optInt("start"), o.optInt("end"), o.optBoolean("bold"), o.optBoolean("italic"))
        }
    }

    fun layout(text: CharSequence, paint: TextPaint, lineHeightPx: Int, widthPx: Int, align: Layout.Alignment): StaticLayout {
        val spanned = SpannableString(text)
        spanned.setSpan(FixedLineHeight(lineHeightPx), 0, spanned.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        return StaticLayout.Builder.obtain(spanned, 0, spanned.length, paint, widthPx.coerceAtLeast(1))
            .setAlignment(align)
            .setIncludePad(false)
            .build()
    }

    /** Returns (width, height) in dp. Thread-safe: each thread uses its own paint. */
    fun measure(text: String, style: JSONObject, maxWidth: Double, density: Float): Pair<Double, Double> {
        val paint = paints.get()!!
        configure(paint, style.optDouble("fontSize", 17.0), style.optInt("fontWeight", 400), density, style.optString("fontFamily") == "mono")
        val maxPx = (maxWidth * density).coerceAtMost(1_000_000.0).toInt()
        val content = spanned(text, runsOf(style.optJSONArray("spans")))
        val layout = layout(content, paint, (style.optDouble("lineHeight", 22.0) * density).roundToInt(), maxPx, Layout.Alignment.ALIGN_NORMAL)
        var width = 0f
        for (i in 0 until layout.lineCount) width = maxOf(width, layout.getLineWidth(i))
        return ceil(width) / density.toDouble() to layout.height / density.toDouble()
    }
}

/** Forces every line box to the runtime's line height, centering the glyphs in it. */
private class FixedLineHeight(private val px: Int) : LineHeightSpan {
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val glyphs = fm.descent - fm.ascent
        if (glyphs <= 0) return
        val extra = px - glyphs
        fm.ascent -= Math.floorDiv(extra, 2)
        fm.descent = fm.ascent + px
        fm.top = fm.ascent
        fm.bottom = fm.descent
    }
}
