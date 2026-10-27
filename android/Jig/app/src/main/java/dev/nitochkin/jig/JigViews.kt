package dev.nitochkin.jig

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.Color
import android.animation.ArgbEvaluator
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import androidx.core.animation.doOnEnd
import android.graphics.RectF
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.MotionEvent
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
    /** Set on list rows: swipe actions and drag-to-reorder. */
    var rowGestures: RowGestures? = null
    /** A whiteboard card's app: a picture, so touches go to the card around it. */
    var blocksTouches = false
    /** The builder's select mode: a tap picks the view under it (in this layout's coordinates). */
    var onSelectTap: ((Float, Float) -> Unit)? = null

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (blocksTouches) return false
        val select = onSelectTap ?: return super.dispatchTouchEvent(ev)
        if (ev.actionMasked == MotionEvent.ACTION_UP) select(ev.x, ev.y)
        return true
    }

    override fun onInterceptTouchEvent(ev: MotionEvent) = rowGestures?.intercept(this, ev) ?: false

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
        val g = rowGestures ?: return super.onTouchEvent(ev)
        // While a swipe or drag owns the touch, the row's own press and click don't see it.
        if (g.active(this)) {
            g.touch(this, ev)
            return true
        }
        super.onTouchEvent(ev)
        g.touch(this, ev)
        if (g.active(this)) {
            val cancel = MotionEvent.obtain(ev).apply { action = MotionEvent.ACTION_CANCEL }
            super.onTouchEvent(cancel)
            cancel.recycle()
        }
        return true
    }

    init {
        // As on iOS and the web: children may draw outside (a row still sliding into place).
        // Rounded containers and scroll views clip through their own outline instead.
        clipChildren = false
        clipToPadding = false
    }

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
    /** Paging (the builder's screen pager): a swipe settles on a page and reports it. */
    var paging = false
    var onPage: ((Int) -> Unit)? = null
    private var downX = 0f
    private var page = 0

    init {
        addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.MATCH_PARENT))
        isHorizontalScrollBarEnabled = false
    }

    fun setContentSize(width: Int, height: Int) {
        content.contentWidth = width
        content.contentHeight = height
        content.requestLayout()
    }

    fun show(page: Int, animated: Boolean) {
        this.page = page
        val x = page * width
        if (width == 0 || scrollX == x) return
        if (animated) smoothScrollTo(x, 0) else scrollTo(x, 0)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        super.onLayout(changed, l, t, r, b)
        if (paging && width > 0 && scrollX != page * width) scrollTo(page * width, 0)
    }

    override fun fling(velocityX: Int) {
        if (!paging) super.fling(velocityX)
    }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) downX = ev.x
        return super.onInterceptTouchEvent(ev)
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) downX = ev.x
        val handled = super.onTouchEvent(ev)
        if (paging && width > 0 && (ev.actionMasked == MotionEvent.ACTION_UP || ev.actionMasked == MotionEvent.ACTION_CANCEL)) {
            // A swipe of a fifth of the width turns the page; less springs back.
            val dx = downX - ev.x
            val pages = maxOf(1, (content.width + width - 1) / width)
            val next = when {
                dx > width / 5f -> page + 1
                dx < -width / 5f -> page - 1
                else -> page
            }.coerceIn(0, pages - 1)
            show(next, true)
            onPage?.invoke(next)
        }
        return handled
    }
}

/**
 * The builder's whiteboard: a 2D scroll view that pans with one finger and zooms with two.
 * Children are positioned by the runtime inside [content], which scales from its top left.
 */
class JigCanvasView(context: Context) : FrameLayout(context) {
    val content = JigLayout(context)
    private var zoom = 1f
    private val scroller = android.widget.OverScroller(context)
    private val slop = android.view.ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var dragging = false

    private val scale = android.view.ScaleGestureDetector(context, object : android.view.ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: android.view.ScaleGestureDetector): Boolean {
            val next = (zoom * d.scaleFactor).coerceIn(0.3f, 2.5f)
            // Keep the point between the fingers where it is.
            val px = (scrollX + d.focusX) / zoom
            val py = (scrollY + d.focusY) / zoom
            zoom = next
            content.scaleX = zoom
            content.scaleY = zoom
            scrollTo((px * zoom - d.focusX).toInt(), (py * zoom - d.focusY).toInt())
            return true
        }
    })

    private val gestures = android.view.GestureDetector(context, object : android.view.GestureDetector.SimpleOnGestureListener() {
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            scrollBy(dx.toInt(), dy.toInt())
            return true
        }

        override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
            scroller.fling(scrollX, scrollY, -vx.toInt(), -vy.toInt(), 0, maxX(), 0, maxY())
            postInvalidateOnAnimation()
            return true
        }
    })

    init {
        addView(content, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        content.pivotX = 0f
        content.pivotY = 0f
    }

    fun setContentSize(width: Int, height: Int) {
        content.contentWidth = width
        content.contentHeight = height
        content.requestLayout()
    }

    private fun maxX() = maxOf(0, (content.contentWidth * zoom).toInt() - width)
    private fun maxY() = maxOf(0, (content.contentHeight * zoom).toInt() - height)

    override fun scrollTo(x: Int, y: Int) = super.scrollTo(x.coerceIn(0, maxX()), y.coerceIn(0, maxY()))

    override fun computeScroll() {
        if (scroller.computeScrollOffset()) {
            scrollTo(scroller.currX, scroller.currY)
            postInvalidateOnAnimation()
        }
    }

    /** Taps go to the cards; a drag or a pinch is the canvas's. */
    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.x
                downY = ev.y
                dragging = false
                scroller.forceFinished(true)
                gestures.onTouchEvent(ev)
                scale.onTouchEvent(ev)
            }
            MotionEvent.ACTION_POINTER_DOWN -> dragging = true
            MotionEvent.ACTION_MOVE -> if (kotlin.math.abs(ev.x - downX) > slop || kotlin.math.abs(ev.y - downY) > slop) dragging = true
        }
        if (dragging) parent?.requestDisallowInterceptTouchEvent(true)
        return dragging
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
        scale.onTouchEvent(ev)
        if (!scale.isInProgress) gestures.onTouchEvent(ev)
        return true
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
        private set
    /** The previous text while it cross-fades out (value transitions). */
    private var fading: StaticLayout? = null
    private var fade = 1f
    private var fadeAnimator: ValueAnimator? = null

    fun setText(value: String, crossfade: Long = 0) {
        if (text == value) return
        fadeAnimator?.cancel()
        fading = if (crossfade > 0) layout else null
        text = value
        invalidateLayout()
        if (fading != null) {
            fadeAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = crossfade
                addUpdateListener {
                    fade = it.animatedValue as Float
                    invalidate()
                }
                doOnEnd { fading = null; fade = 1f }
                start()
            }
        }
    }
    private var fontSize = 17.0
    private var fontWeight = 400
    private var lineHeight = 22.0
    private var align = Layout.Alignment.ALIGN_NORMAL
    private var mono = false

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    fun setStyle(fontSize: Double, fontWeight: Int, lineHeight: Double, color: Int, align: Layout.Alignment, mono: Boolean = false) {
        if (this.fontSize != fontSize || this.fontWeight != fontWeight || this.lineHeight != lineHeight || this.align != align || this.mono != mono) {
            this.fontSize = fontSize
            this.fontWeight = fontWeight
            this.lineHeight = lineHeight
            this.align = align
            this.mono = mono
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
        if (width <= 0) return
        if (text.isEmpty()) {
            fading?.let { drawLayout(canvas, it) }
            return
        }
        val l = layout ?: run {
            TextStyle.configure(paint, fontSize, fontWeight, d, mono)
            TextStyle.layout(text, paint, (lineHeight * d).roundToInt(), width, align).also { layout = it }
        }
        val color = paint.color
        fading?.let {
            paint.alpha = ((1 - fade) * Color.alpha(color)).toInt()
            drawLayout(canvas, it)
            paint.color = color
            paint.alpha = (fade * Color.alpha(color)).toInt()
        }
        drawLayout(canvas, l)
        paint.color = color
    }

    private fun drawLayout(canvas: Canvas, l: StaticLayout) {
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
    private var fill: Int? = 0xFF000000.toInt()
    private var stroke: Int? = null
    private var trimStart = 0f
    private var trimEnd = 1f
    private val measure = PathMeasure()
    private val segment = Path()
    private var animator: ValueAnimator? = null

    /** Colors and stroke trim (0..1), animated together when the node has a value transition. */
    fun setColors(fill: Int?, stroke: Int?, animation: Pair<Long, TimeInterpolator>?) = update(fill, stroke, trimStart, trimEnd, animation)
    fun setTrim(start: Float, end: Float, animation: Pair<Long, TimeInterpolator>?) = update(fill, stroke, start, end, animation)

    private fun update(fill: Int?, stroke: Int?, start: Float, end: Float, animation: Pair<Long, TimeInterpolator>?) {
        if (fill == this.fill && stroke == this.stroke && start == trimStart && end == trimEnd) return
        animator?.cancel()
        if (animation == null) {
            this.fill = fill
            this.stroke = stroke
            trimStart = start
            trimEnd = end
            invalidate()
            return
        }
        val from = floatArrayOf(trimStart, trimEnd)
        val fromFill = this.fill ?: Color.TRANSPARENT
        val fromStroke = this.stroke ?: Color.TRANSPARENT
        val argb = ArgbEvaluator()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = animation.first
            interpolator = animation.second
            addUpdateListener {
                val f = it.animatedValue as Float
                trimStart = from[0] + (start - from[0]) * f
                trimEnd = from[1] + (end - from[1]) * f
                this@JigShapeView.fill = fill?.let { c -> argb.evaluate(f, fromFill, c) as Int }
                this@JigShapeView.stroke = stroke?.let { c -> argb.evaluate(f, fromStroke, c) as Int }
                invalidate()
            }
            start()
        }
    }
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
            if (trimStart <= 0f && trimEnd >= 1f) {
                canvas.drawPath(scaled, strokePaint)
            } else if (trimEnd > trimStart) {
                // Stroke trimming as in Core Animation: draw only that fraction of the path.
                measure.setPath(scaled, false)
                segment.reset()
                var offset = 0f
                var total = 0f
                do total += measure.length while (measure.nextContour())
                measure.setPath(scaled, false)
                do {
                    val len = measure.length
                    val a = (trimStart * total - offset).coerceIn(0f, len)
                    val b = (trimEnd * total - offset).coerceIn(0f, len)
                    if (b > a) measure.getSegment(a, b, segment, true)
                    offset += len
                } while (measure.nextContour())
                canvas.drawPath(segment, strokePaint)
            }
        }
    }
}
