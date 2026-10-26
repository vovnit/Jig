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

/**
 * One place that turns the runtime's text metrics into a StaticLayout, so
 * measurement (on the JS thread) and drawing (JigTextView) always agree.
 */
object TextStyle {
    private val paints = ThreadLocal.withInitial { TextPaint(Paint.ANTI_ALIAS_FLAG) }

    fun typeface(weight: Int): Typeface =
        if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, weight.coerceIn(1, 1000), false)
        else if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT

    fun configure(paint: TextPaint, fontSize: Double, fontWeight: Int, density: Float) {
        paint.textSize = (fontSize * density).toFloat()
        paint.typeface = typeface(fontWeight)
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
    fun measure(text: String, fontSize: Double, fontWeight: Int, lineHeight: Double, maxWidth: Double, density: Float): Pair<Double, Double> {
        val paint = paints.get()!!
        configure(paint, fontSize, fontWeight, density)
        val maxPx = (maxWidth * density).coerceAtMost(1_000_000.0).toInt()
        val layout = layout(text, paint, (lineHeight * density).roundToInt(), maxPx, Layout.Alignment.ALIGN_NORMAL)
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
