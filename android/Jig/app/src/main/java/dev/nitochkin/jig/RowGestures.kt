package dev.nitochkin.jig

import android.graphics.Rect
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Choreographer
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.PathInterpolator
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * List row gestures: swipe a row left to reveal its actions, long-press it to drag and
 * reorder. The runtime owns the order: a dragged row reports each neighbour it passes
 * ("move"), the runtime reorders the items and sends new frames, and the row stays under
 * the finger meanwhile while its siblings animate into place.
 *
 * Rows are JigLayouts that route their touch events here (see JigLayout.rowGestures).
 */
class RowGestures(
    private val density: Float,
    /** The frame the runtime last gave a node, in px (the view may still be animating to it). */
    private val frameOf: (Int) -> Rect?,
    private val dispatch: (Int, String, JSONObject) -> Unit,
) {
    class SwipeAction(val label: String, val color: Int)

    private val actions = HashMap<Int, List<SwipeAction>>()
    private val reorderable = HashSet<Int>()
    private val ease = PathInterpolator(0.2f, 0.8f, 0.2f, 1f)

    private enum class Mode { PENDING, SWIPE, DRAG }

    private class Gesture(val row: JigLayout, val x0: Float, val y0: Float) {
        var mode = Mode.PENDING
        var y = y0
        var base = 0f
        var panel: View? = null
        var home0 = 0
        var scroll: JigScrollView? = null
        var scroll0 = 0
        var pendingAt = 0L
        var longPress: Runnable? = null
    }

    private var gesture: Gesture? = null
    private var open: Triple<JigLayout, View, Float>? = null
    private var ticking = false

    fun setActions(view: JigLayout, list: List<SwipeAction>) {
        val id = view.tag as Int
        if (list.isEmpty()) actions.remove(id) else actions[id] = list
        view.rowGestures = this
    }

    fun setReorder(view: JigLayout, on: Boolean) {
        val id = view.tag as Int
        if (on) reorderable.add(id) else reorderable.remove(id)
        view.rowGestures = this
    }

    fun isDragging(id: Int) = gesture?.let { it.mode == Mode.DRAG && it.row.tag == id } == true

    /** The runtime moved a row: keep a dragged row under the finger, and an open row's actions beside it. */
    fun framed(id: Int) {
        val g = gesture
        if (g != null && g.mode == Mode.DRAG && g.row.tag == id) {
            g.pendingAt = 0
            positionDrag(g)
        }
        open?.let { (row, panel) -> if (row.tag == id) placePanel(panel, id) }
    }

    fun forget(id: Int) {
        actions.remove(id)
        reorderable.remove(id)
        open?.let { (row, panel) ->
            if (row.tag == id) {
                (panel.parent as? ViewGroup)?.removeView(panel)
                open = null
            }
        }
        if (gesture?.row?.tag == id) gesture = null
    }

    /** A touch anywhere outside an open row's actions closes it. */
    fun onSurfaceDown(rawX: Float, rawY: Float) {
        val (_, panel) = open ?: return
        val r = Rect()
        panel.getGlobalVisibleRect(r)
        if (!r.contains(rawX.roundToInt(), rawY.roundToInt())) close()
    }

    fun close() {
        val (row, panel) = open ?: return
        open = null
        row.animate().translationX(0f).setDuration(220).setInterpolator(ease).withEndAction { (panel.parent as? ViewGroup)?.removeView(panel) }
    }

    // ---------- Touch routing (from JigLayout) ----------

    /**
     * Events on their way to the row's children: take them over once a swipe or drag owns
     * the touch. An intercepted event doesn't reach the row's onTouchEvent, so handle it here.
     */
    fun intercept(row: JigLayout, e: MotionEvent): Boolean {
        val g = gesture
        if (g != null && g.row === row && g.mode != Mode.PENDING) {
            move(g, e)
            return true
        }
        observe(row, e)
        return active(row)
    }

    /** Events the row handles itself. */
    fun touch(row: JigLayout, e: MotionEvent) {
        val g = gesture
        if (g != null && g.row === row && g.mode != Mode.PENDING) move(g, e) else observe(row, e)
    }

    /** A swipe or drag owns this row's touch. */
    fun active(row: JigLayout) = gesture?.let { it.row === row && it.mode != Mode.PENDING } == true

    private fun observe(row: JigLayout, e: MotionEvent) {
        val id = row.tag as? Int ?: return
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (gesture != null) return
                val g = Gesture(row, e.rawX, e.rawY)
                gesture = g
                if (id in reorderable) {
                    g.longPress = Runnable { if (gesture === g && g.mode == Mode.PENDING) beginDrag(g) }
                    row.postDelayed(g.longPress, ViewConfiguration.getLongPressTimeout().toLong())
                }
            }
            MotionEvent.ACTION_MOVE -> {
                val g = gesture?.takeIf { it.row === row } ?: return
                if (g.mode != Mode.PENDING) return move(g, e)
                g.y = e.rawY
                val dx = e.rawX - g.x0
                val dy = e.rawY - g.y0
                val slop = ViewConfiguration.get(row.context).scaledTouchSlop
                if (abs(dx) > slop && abs(dx) > abs(dy) && id in actions && (dx < 0 || open?.first === row)) beginSwipe(g)
                else if (abs(dx) > slop || abs(dy) > slop) cancel(g)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val g = gesture?.takeIf { it.row === row } ?: return
                if (g.mode == Mode.PENDING) cancel(g) else move(g, e)
            }
        }
    }

    private fun cancel(g: Gesture) {
        g.longPress?.let(g.row::removeCallbacks)
        if (gesture === g) gesture = null
    }

    private fun move(g: Gesture, e: MotionEvent) {
        val ended = e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL
        when (g.mode) {
            Mode.SWIPE -> if (ended) endSwipe(g, e.actionMasked == MotionEvent.ACTION_CANCEL) else moveSwipe(g, e.rawX)
            Mode.DRAG -> if (ended) endDrag(g) else {
                g.y = e.rawY
                positionDrag(g)
            }
            Mode.PENDING -> Unit
        }
    }

    // ---------- Swipe ----------

    private fun beginSwipe(g: Gesture) {
        g.longPress?.let(g.row::removeCallbacks)
        g.row.parent?.requestDisallowInterceptTouchEvent(true)
        val reopening = open?.takeIf { it.first === g.row }
        if (open != null && reopening == null) close()
        open = null
        g.panel = reopening?.second ?: makePanel(g.row)
        g.base = if (reopening != null) -reopening.third else 0f
        g.mode = Mode.SWIPE
    }

    private fun moveSwipe(g: Gesture, rawX: Float) {
        val width = g.row.width.toFloat()
        var tx = g.base + rawX - g.x0
        // Rubber band past the edges.
        if (tx > 0) tx /= 4
        if (tx < -width) tx = -width - (-width - tx) / 4
        g.row.translationX = tx
    }

    private fun endSwipe(g: Gesture, cancelled: Boolean) {
        gesture = null
        val row = g.row
        val panel = g.panel ?: return
        val id = row.tag as Int
        val width = row.width.toFloat()
        val actionsWidth = panelWidth(panel)
        val tx = row.translationX
        when {
            !cancelled && tx < -width * 0.6f -> {
                // A full swipe runs the first action.
                row.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                row.animate().translationX(-width).setDuration(200).setInterpolator(ease).withEndAction {
                    (panel.parent as? ViewGroup)?.removeView(panel)
                    dispatch(id, "swipe", JSONObject().put("index", 0))
                    // If the action kept the row, bring it back.
                    row.animate().translationX(0f).setDuration(220).setInterpolator(ease)
                }
            }
            !cancelled && tx < -actionsWidth / 2 -> {
                open = Triple(row, panel, actionsWidth)
                row.animate().translationX(-actionsWidth).setDuration(220).setInterpolator(ease)
            }
            else -> row.animate().translationX(0f).setDuration(220).setInterpolator(ease).withEndAction { (panel.parent as? ViewGroup)?.removeView(panel) }
        }
    }

    /** The actions sit behind the row, right-aligned, and show as the row slides away. */
    private fun makePanel(row: JigLayout): View {
        val id = row.tag as Int
        val panel = LinearLayout(row.context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        (actions[id] ?: emptyList()).forEachIndexed { index, a ->
            panel.addView(TextView(row.context).apply {
                text = a.label
                setTextColor(0xFFFFFFFF.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                gravity = Gravity.CENTER
                setBackgroundColor(a.color)
                val pad = (16 * density).roundToInt()
                setPadding(pad, 0, pad, 0)
                minWidth = (74 * density).roundToInt()
                setOnClickListener {
                    dispatch(id, "swipe", JSONObject().put("index", index))
                    close()
                }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        val body = row.parent as ViewGroup
        body.addView(panel, body.indexOfChild(row), FrameParams())
        placePanel(panel, id)
        return panel
    }

    private fun placePanel(panel: View, id: Int) {
        val f = frameOf(id) ?: return
        val p = panel.layoutParams as FrameParams
        p.x = f.left
        p.y = f.top
        p.width = f.width()
        p.height = f.height()
        panel.requestLayout()
    }

    private fun panelWidth(panel: View): Float {
        val group = panel as ViewGroup
        var w = 0
        for (i in 0 until group.childCount) w += group.getChildAt(i).width
        return w.toFloat()
    }

    // ---------- Drag ----------

    private fun beginDrag(g: Gesture) {
        val f = frameOf(g.row.tag as Int) ?: return
        close()
        g.mode = Mode.DRAG
        g.home0 = f.top
        var v = g.row.parent
        while (v != null && v !is JigScrollView) v = v.parent
        g.scroll = v as? JigScrollView
        g.scroll0 = g.scroll?.scrollY ?: 0
        g.row.parent?.requestDisallowInterceptTouchEvent(true)
        // The long press is a drag now, not a press that ends in a tap.
        g.row.isPressed = false
        g.row.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        // Children draw by Z, so the lifted row draws above its siblings whatever its index.
        g.row.animate().translationZ(8 * density).scaleX(1.02f).scaleY(1.02f).setDuration(150)
        positionDrag(g)
        if (!ticking) {
            ticking = true
            Choreographer.getInstance().postFrameCallback(::tick)
        }
    }

    /** The row follows the finger; passing the middle of a neighbour reports a move. */
    private fun positionDrag(g: Gesture) {
        val id = g.row.tag as Int
        val f = frameOf(id) ?: return
        val body = g.row.parent as? ViewGroup ?: return
        val scrolled = (g.scroll?.scrollY ?: 0) - g.scroll0
        val h = f.height()
        // Half a row of travel past either end, so the row can pass the middle of the last one.
        val y = (g.home0 + g.y - g.y0 + scrolled).coerceIn(-h / 2f, body.height - h / 2f)
        g.row.translationY = y - f.top
        if (g.pendingAt > 0 && System.currentTimeMillis() - g.pendingAt < 500) return
        val center = y + h / 2f
        var above: Rect? = null
        var below: Rect? = null
        for (i in 0 until body.childCount) {
            val c = body.getChildAt(i)
            val cid = c.tag as? Int ?: continue
            if (c === g.row || !c.isEnabled || (cid !in reorderable && cid !in actions)) continue
            val r = frameOf(cid) ?: continue
            if (r.top < f.top && (above == null || r.top > above.top)) above = r
            if (r.top > f.top && (below == null || r.top < below.top)) below = r
        }
        val by = when {
            below != null && center > below.exactCenterY() -> 1
            above != null && center < above.exactCenterY() -> -1
            else -> return
        }
        g.pendingAt = System.currentTimeMillis()
        g.row.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        dispatch(id, "move", JSONObject().put("by", by))
    }

    /** Near the top or bottom edge of the scroll view, scroll it so the row can travel further. */
    private fun tick(@Suppress("UNUSED_PARAMETER") frameTimeNanos: Long) {
        val g = gesture?.takeIf { it.mode == Mode.DRAG }
        if (g == null) {
            ticking = false
            return
        }
        g.scroll?.let { scroll ->
            val loc = IntArray(2)
            scroll.getLocationOnScreen(loc)
            val y = g.y - loc[1]
            val edge = 60 * density
            val speed = when {
                y < edge -> -(edge - y) / 4
                y > scroll.height - edge -> (y - (scroll.height - edge)) / 4
                else -> 0f
            }
            if (speed != 0f) {
                val before = scroll.scrollY
                scroll.scrollBy(0, speed.roundToInt())
                if (scroll.scrollY != before) positionDrag(g)
            }
        }
        Choreographer.getInstance().postFrameCallback(::tick)
    }

    private fun endDrag(g: Gesture) {
        gesture = null
        g.row.animate().translationY(0f).translationZ(0f).scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(ease)
    }
}
