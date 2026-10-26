package dev.nitochkin.jig

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import androidx.core.graphics.PathParser
import kotlin.math.min
import kotlin.math.roundToInt

/** Where the runtime put a view, in px relative to its parent. */
class FrameParams(var x: Int = 0, var y: Int = 0, w: Int = 0, h: Int = 0) : ViewGroup.LayoutParams(w, h)

/**
 * A container that places children exactly at the frames the JS layout computed.
 * Android's own measuring only enforces those sizes.
 */
class JigLayout(context: Context) : ViewGroup(context) {
    /** Size when the parent leaves it open (the content of a scroll view). */
    var contentWidth = 0
    var contentHeight = 0

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val p = child.layoutParams as? FrameParams ?: continue
            child.measure(
                MeasureSpec.makeMeasureSpec(p.width.coerceAtLeast(0), MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(p.height.coerceAtLeast(0), MeasureSpec.EXACTLY),
            )
        }
        setMeasuredDimension(resolve(widthMeasureSpec, contentWidth), resolve(heightMeasureSpec, contentHeight))
    }

    private fun resolve(spec: Int, content: Int) =
        if (MeasureSpec.getMode(spec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(spec) else content

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val p = child.layoutParams as? FrameParams ?: continue
            child.layout(p.x, p.y, p.x + p.width, p.y + p.height)
        }
    }

    override fun generateDefaultLayoutParams() = FrameParams()
    override fun checkLayoutParams(p: LayoutParams?) = p is FrameParams
    override fun generateLayoutParams(p: LayoutParams?) = FrameParams()
    override fun shouldDelayChildPressedState() = false
}

/** Scroll views keep runtime children in a content JigLayout sized to the content. */
class JigScrollView(context: Context) : ScrollView(context) {
    val content = JigLayout(context)

    init {
        addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        isVerticalScrollBarEnabled = true
    }

    fun setContentSize(width: Int, height: Int) {
        content.contentWidth = width
        content.contentHeight = height
        content.requestLayout()
    }
}

class JigHScrollView(context: Context) : HorizontalScrollView(context) {
    val content = JigLayout(context)

    init {
        addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.MATCH_PARENT))
        isHorizontalScrollBarEnabled = false
    }

    fun setContentSize(width: Int, height: Int) {
        content.contentWidth = width
        content.contentHeight = height
        content.requestLayout()
    }
}

/**
 * Text drawn with the same StaticLayout the runtime measures with
 * (`TextStyle.measure`), so wrapping always matches the measured height.
 * Buttons use it too, with their label centered.
 */
@SuppressLint("ViewConstructor")
class JigTextView(context: Context, private val isButton: Boolean) : View(context) {
    private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private var layout: StaticLayout? = null

    var text = ""
        set(v) { if (field != v) { field = v; invalidateLayout() } }
    private var fontSize = 17.0
    private var fontWeight = 400
    private var lineHeight = 22.0
    private var align = Layout.Alignment.ALIGN_NORMAL

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    fun setStyle(fontSize: Double, fontWeight: Int, lineHeight: Double, color: Int, align: Layout.Alignment) {
        if (this.fontSize != fontSize || this.fontWeight != fontWeight || this.lineHeight != lineHeight || this.align != align) {
            this.fontSize = fontSize
            this.fontWeight = fontWeight
            this.lineHeight = lineHeight
            this.align = align
            invalidateLayout()
        }
        if (paint.color != color) {
            paint.color = color
            invalidate()
        }
    }

    private fun invalidateLayout() {
        layout = null
        contentDescription = text
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        layout = null
    }

    override fun onDraw(canvas: Canvas) {
        val d = resources.displayMetrics.density
        // Frames and padding are rounded to whole pixels separately, so the box can come out a
        // pixel narrower than the measured text; one dp of slack keeps the measured line breaks.
        val width = width - paddingLeft - paddingRight + d.roundToInt()
        if (text.isEmpty() || width <= 0) return
        val l = layout ?: run {
            TextStyle.configure(paint, fontSize, fontWeight, d)
            TextStyle.layout(text, paint, (lineHeight * d).roundToInt(), width, align).also { layout = it }
        }
        canvas.save()
        val free = height - paddingTop - paddingBottom - l.height
        canvas.translate(paddingLeft.toFloat(), paddingTop + if (isButton) free / 2f else 0f)
        l.draw(canvas)
        canvas.restore()
    }

    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        if (isButton) info.className = "android.widget.Button"
    }
}

/** A shape node: SVG path data in a viewBox, scaled to fit the view (xMidYMid meet). */
class JigShapeView(context: Context) : View(context) {
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val matrix = Matrix()
    private val scaled = Path()
    private var path: Path? = null

    var pathData = ""
        set(v) {
            if (field == v) return
            field = v
            path = if (v.isEmpty()) null else runCatching { PathParser.createPathFromPathData(v) }.getOrNull()
            invalidate()
        }
    var viewBox = RectF(0f, 0f, 24f, 24f)
        set(v) { if (field != v) { field = v; invalidate() } }
    var fill: Int? = 0xFF000000.toInt()
        set(v) { field = v; invalidate() }
    var stroke: Int? = null
        set(v) { field = v; invalidate() }
    var strokeWidth = 1f
        set(v) { field = v; invalidate() }
    var lineCap = Paint.Cap.BUTT
        set(v) { field = v; invalidate() }

    override fun onDraw(canvas: Canvas) {
        val p = path ?: return
        if (viewBox.width() <= 0 || viewBox.height() <= 0) return
        val scale = min(width / viewBox.width(), height / viewBox.height())
        matrix.reset()
        matrix.setTranslate(-viewBox.left, -viewBox.top)
        matrix.postScale(scale, scale)
        matrix.postTranslate((width - viewBox.width() * scale) / 2f, (height - viewBox.height() * scale) / 2f)
        p.transform(matrix, scaled)
        fill?.let {
            fillPaint.color = it
            canvas.drawPath(scaled, fillPaint)
        }
        stroke?.let {
            strokePaint.color = it
            strokePaint.strokeWidth = strokeWidth * scale
            strokePaint.strokeCap = lineCap
            canvas.drawPath(scaled, strokePaint)
        }
    }
}
