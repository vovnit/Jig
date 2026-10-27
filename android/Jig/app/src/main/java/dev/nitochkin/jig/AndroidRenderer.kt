package dev.nitochkin.jig

import android.animation.ObjectAnimator
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
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
import android.view.animation.LinearInterpolator
import android.view.animation.OvershootInterpolator
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.Switch
import androidx.core.animation.doOnEnd
import androidx.core.view.drawToBitmap
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
    /** Called after each batch with whether a screen stack on screen can pop. */
    var onCanGoBack: ((Boolean) -> Unit)? = null
    var accentColor = 0xFF3B6EF6.toInt()
    var isDark = false
    /** The theme's background, for making a screen opaque while it slides. */
    var screenBackground = Color.WHITE
    val density = surface.resources.displayMetrics.density

    private class Node(val type: String, val view: View) {
        val props = HashMap<String, Any?>()
        val style = HashMap<String, Any?>()
        val background = GradientDrawable()
        var rippleRadius = -1f
        var backgroundColor = Color.TRANSPARENT
        /** Set while the runtime writes a control's value, so it isn't reported back as a change. */
        var updating = false
        /** Set after the first render: only later changes animate. */
        var rendered = false
        var frameAnimator: ValueAnimator? = null
        var colorAnimator: ValueAnimator? = null
    }

    private class Transition(val duration: Long, val interpolator: TimeInterpolator)

    private val nodes = HashMap<Int, Node>()
    /** Nodes created in the batch being applied: they appear without animating their frame. */
    private val createdNow = HashSet<Int>()
    /** Removed views still fading out: they stay on screen but no longer count as children. */
    private val leaving = HashSet<View>()

    /** Screen stacks, one per runtime root (the shell, or an app running inside it): the
     *  navigation depth, and what each screen below the current one looked like when it was
     *  left (taken on push), shown under the current screen during a predictive back gesture. */
    private val depths = HashMap<Int, Int>()
    private val screenSnapshots = HashMap<Int, ArrayList<Bitmap?>>()
    private var screensAnimating = false
    private var interactiveTarget = 0
    private var interactiveBack: ImageView? = null
    private var interactiveDim: ColorDrawable? = null
    private var interactiveProgress = 0f
    /** Set once a back gesture committed: the pop it causes (on this root) is already on screen. */
    private var awaitingInteractivePop = 0
    private val context = surface.context
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    /** The text field being edited, kept visible above the keyboard. */
    private var focusedField: EditText? = null
    /** The frame the runtime last gave each node, in px; a view may still be animating to it. */
    private val targets = HashMap<Int, android.graphics.Rect>()
    private val reportingScroll = HashSet<Int>()
    /** Swipe actions and drag-to-reorder on list rows. */
    val rows = RowGestures(density, frameOf = { targets[it] }, dispatch = { id, name, payload -> dispatch?.invoke(id, name, payload) })

    /** The platform switch's intrinsic size in dp, measured once on main. */
    fun toggleSize(): Pair<Double, Double> {
        val s = Switch(context)
        s.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        return s.measuredWidth / density.toDouble() to s.measuredHeight / density.toDouble()
    }

    // ---------- Ops ----------

    fun apply(json: String) {
        val ops = JSONArray(json)
        // A screen transition: keep a picture of the old screen to animate away from. The
        // command names the root of the runtime that navigated.
        var screenTransition: JSONArray? = null
        var target = 0
        for (i in 0 until ops.length()) {
            val op = ops.getJSONArray(i)
            if (op.getString(0) == "command" && op.getString(2) == "transition") {
                screenTransition = op.getJSONArray(3)
                target = op.getInt(1)
            }
        }
        val root = nodes[target]?.view
        val interactivePop = target != 0 && awaitingInteractivePop == target
        val bitmap = if (screenTransition != null && !interactivePop && root != null && root.isLaidOut && root.width > 0) root.drawToBitmap() else null
        val snapshot = bitmap?.let { b -> root?.let { snapshotView(b, it) } }
        createdNow.clear()
        for (i in 0 until ops.length()) {
            val op = ops.getJSONArray(i)
            when (op.getString(0)) {
                "create" -> create(op.getInt(1), op.getString(2), op.getJSONObject(3))
                "update" -> update(op.getInt(1), op.getJSONObject(2))
                // A list row scrolling into or out of its window (`quiet`) comes and goes without fading.
                "insert" -> insert(op.getInt(1), op.getInt(2), op.getInt(3), animated = snapshot == null && !interactivePop && !op.optBoolean(4))
                "remove" -> remove(op.getInt(2), animated = snapshot == null && !interactivePop && !op.optBoolean(3))
                "frame" -> frame(op.getInt(1), op.getDouble(2), op.getDouble(3), op.getDouble(4), op.getDouble(5))
                "command" -> when (op.getString(2)) {
                    "focus" -> nodes[op.getInt(1)]?.view?.requestFocus()
                    "depth" -> depths[op.getInt(1)] = op.getJSONArray(3).getInt(0)
                }
            }
        }
        val kind = screenTransition?.getString(0)
        if (interactivePop) {
            finishInteractivePop()
        } else if (snapshot != null && root != null && screenTransition != null) {
            animateScreens(kind!!, screenTransition.getString(1), screenTransition.getLong(2), root, snapshot)
        }
        // Keep one snapshot per screen below the current one, for predictive back.
        if (target != 0 && kind == "push") screenSnapshots.getOrPut(target) { ArrayList() }.add(bitmap)
        for ((id, depth) in depths) {
            val stack = screenSnapshots.getOrPut(id) { ArrayList() }
            while (stack.size < depth - 1) stack.add(null)
            while (stack.size > maxOf(0, depth - 1)) stack.removeAt(stack.size - 1)
        }
        onCanGoBack?.invoke(backTarget() != null)
        // Layout may have moved the field (a new row, a viewport shrunk by the keyboard).
        surface.post { revealFocusedField() }
    }

    private fun create(id: Int, type: String, props: JSONObject) {
        val view = makeView(id, type)
        view.tag = id
        val node = Node(type, view)
        nodes[id] = node
        createdNow.add(id)
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

    private fun insert(parentId: Int, childId: Int, index: Int, animated: Boolean) {
        val parent = nodes[parentId]?.view ?: return
        val child = nodes[childId]?.view ?: return
        val container = when (parent) {
            is JigScrollView -> parent.content
            is JigHScrollView -> parent.content
            is JigCanvasView -> parent.content
            is ViewGroup -> parent
            else -> return
        }
        // Indexes count live children only: views still fading out (and a row's swipe actions) are skipped.
        val live = (0 until container.childCount).map(container::getChildAt).filter { it !in leaving && it.tag is Int }
        if (child.parent === container && live.indexOf(child) == index) return
        val siblings = live.filter { it !== child }
        (child.parent as? ViewGroup)?.removeView(child)
        val at = if (index < siblings.size) container.indexOfChild(siblings[index]) else container.childCount
        container.addView(child, at, child.layoutParams as? FrameParams ?: FrameParams())
        // An embedded app's root, drawn at its `app` node's scale from the top left.
        (num(nodes[parentId]?.props?.get("contentScale")))?.let { applyScale(child, it.toFloat()) }
        // A node with a value transition fades in when it appears in an existing list.
        val t = nodes[childId]?.let(::transition)
        if (animated && t != null && childId in createdNow && parentId !in createdNow) {
            val target = child.alpha
            child.alpha = 0f
            child.animate().alpha(target).setDuration(t.duration).setInterpolator(t.interpolator)
        }
    }

    private fun remove(id: Int, animated: Boolean) {
        val node = nodes[id] ?: return
        val view = node.view
        val t = transition(node)
        forget(view)
        // A node with a value transition fades out in place, above the siblings moving into its spot.
        if (animated && t != null && view.isAttachedToWindow) {
            leaving.add(view)
            view.isEnabled = false
            view.bringToFront()
            view.animate().alpha(0f).setDuration(t.duration).setInterpolator(t.interpolator).withEndAction {
                (view.parent as? ViewGroup)?.removeView(view)
                leaving.remove(view)
            }
            return
        }
        (view.parent as? ViewGroup)?.removeView(view)
    }

    private fun forget(view: View) {
        val id = view.tag as? Int
        if (id != null && nodes[id]?.view === view) {
            nodes.remove(id)
            targets.remove(id)
            depths.remove(id)
            screenSnapshots.remove(id)
            reportingScroll.remove(id)
            rows.forget(id)
            selections.remove(id)
        }
        if (view === focusedField) focusedField = null
        if (view is ViewGroup) for (i in 0 until view.childCount) forget(view.getChildAt(i))
    }

    private fun frame(id: Int, x: Double, y: Double, w: Double, h: Double) {
        val node = nodes[id] ?: return
        val view = node.view
        // Round edges, not sizes, so neighbours never gap or overlap.
        val l = (x * density).roundToInt()
        val t = (y * density).roundToInt()
        val p = view.layoutParams as? FrameParams ?: FrameParams().also { view.layoutParams = it }
        val nw = ((x + w) * density).roundToInt() - l
        val nh = ((y + h) * density).roundToInt() - t
        targets[id] = android.graphics.Rect(l, t, l + nw, t + nh)
        if (p.x == l && p.y == t && p.width == nw && p.height == nh) return
        node.frameAnimator?.cancel()
        val tr = transition(node)
        // A dragged row takes its new place at once: the finger, not an animation, moves it.
        val dragged = rows.isDragging(id)
        if (tr != null && view.isAttachedToWindow && id !in createdNow && !dragged) {
            // Animate the frame by re-laying out the view each tick: positions and sizes move together.
            val from = intArrayOf(p.x, p.y, p.width, p.height)
            val to = intArrayOf(l, t, nw, nh)
            node.frameAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = tr.duration
                interpolator = tr.interpolator
                addUpdateListener { a ->
                    val f = a.animatedValue as Float
                    p.x = lerp(from[0], to[0], f)
                    p.y = lerp(from[1], to[1], f)
                    p.width = lerp(from[2], to[2], f)
                    p.height = lerp(from[3], to[3], f)
                    view.requestLayout()
                }
                start()
            }
            rows.framed(id)
            return
        }
        p.x = l
        p.y = t
        p.width = nw
        p.height = nh
        view.requestLayout()
        rows.framed(id)
    }

    private fun lerp(a: Int, b: Int, f: Float) = (a + (b - a) * f).roundToInt()

    // ---------- Screenshots (the builder) ----------

    /** A PNG (base64) of a node's view at one pixel per dp; a scaled card's app is drawn unscaled. */
    fun snapshot(id: Int): String? {
        val view = nodes[id]?.view ?: return null
        if (view.width == 0 || view.height == 0) return null
        val full = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(full)
        canvas.drawColor(screenBackground)
        view.draw(canvas)
        val small = Bitmap.createScaledBitmap(full, (view.width / density).roundToInt().coerceAtLeast(1), (view.height / density).roundToInt().coerceAtLeast(1), true)
        val out = java.io.ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.PNG, 100, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    // ---------- Select mode (the builder) ----------

    private val selections = HashMap<Int, Pair<GradientDrawable, View.OnLayoutChangeListener>>()

    /** The deepest runtime node under a point, in [v]'s coordinates (children may be scaled). */
    private fun deepest(v: View, x: Float, y: Float): View? {
        if (x < 0 || y < 0 || x > v.width || y > v.height) return null
        if (v is ViewGroup) {
            for (i in v.childCount - 1 downTo 0) {
                val c = v.getChildAt(i)
                if (c.visibility != View.VISIBLE) continue
                val pt = floatArrayOf(x + v.scrollX - c.left, y + v.scrollY - c.top)
                if (!c.matrix.isIdentity) android.graphics.Matrix().also { c.matrix.invert(it) }.mapPoints(pt)
                deepest(c, pt[0], pt[1])?.let { return it }
            }
        }
        val id = v.tag as? Int ?: return null
        return v.takeIf { nodes[id]?.view === it }
    }

    /** The selected node's outline, in the accent color, drawn over it. */
    private fun setSelected(view: View, on: Boolean) {
        val id = view.tag as? Int ?: return
        val existing = selections[id]
        if (!on) {
            existing?.let { (d, l) ->
                view.overlay.remove(d)
                view.removeOnLayoutChangeListener(l)
            }
            selections.remove(id)
            return
        }
        if (existing != null) return
        val outline = GradientDrawable().apply {
            setColor(Color.TRANSPARENT)
            setStroke((2 * density).roundToInt(), accentColor)
            cornerRadius = 4 * density
            setBounds(0, 0, view.width, view.height)
        }
        val follow = View.OnLayoutChangeListener { v, _, _, _, _, _, _, _, _ -> outline.setBounds(0, 0, v.width, v.height) }
        view.addOnLayoutChangeListener(follow)
        view.overlay.add(outline)
        selections[id] = outline to follow
    }

    private fun applyScale(view: View, scale: Float) {
        view.pivotX = 0f
        view.pivotY = 0f
        view.scaleX = scale
        view.scaleY = scale
    }

    /** False when the user turned animations off (developer options, battery saver). */
    private fun animatorsEnabled() = Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled()

    // ---------- Transitions ----------

    /** The node's `style.transition` for a change after its first render, unless animations are off. */
    private fun transition(node: Node): Transition? {
        if (!node.rendered || !animatorsEnabled()) return null
        val t = node.style["transition"] as? JSONObject ?: return null
        val ms = t.optLong("duration")
        if (ms <= 0) return null
        val interpolator: TimeInterpolator = when (t.optString("easing")) {
            "linear" -> LinearInterpolator()
            "easeIn" -> PathInterpolator(0.4f, 0f, 1f, 1f)
            "easeOut" -> PathInterpolator(0f, 0f, 0.2f, 1f)
            "spring" -> OvershootInterpolator(1.4f)
            else -> PathInterpolator(0.4f, 0f, 0.2f, 1f)
        }
        return Transition(ms, interpolator)
    }

    private fun snapshotView(bitmap: Bitmap, root: View) = ImageView(context).apply {
        setImageBitmap(bitmap)
        val p = root.layoutParams as FrameParams
        layoutParams = FrameParams(p.x, p.y, root.width, root.height)
    }

    // ---------- Predictive back ----------

    /** Starts a back gesture: the previous screen's snapshot appears under the current one. */
    fun beginInteractiveBack(): Boolean {
        if (screensAnimating || interactiveBack != null || awaitingInteractivePop != 0) return false
        val target = backTarget() ?: return false
        val root = nodes[target]?.view ?: return false
        val container = root.parent as? ViewGroup ?: return false
        val bitmap = screenSnapshots[target]?.lastOrNull() ?: return false
        val snapshot = snapshotView(bitmap, root)
        val dim = ColorDrawable(Color.BLACK).apply { alpha = 31 }
        snapshot.foreground = dim
        snapshot.translationX = -root.width * 0.3f
        container.addView(snapshot, container.indexOfChild(root))
        root.background = ColorDrawable(screenBackground)
        interactiveTarget = target
        interactiveBack = snapshot
        interactiveDim = dim
        interactiveProgress = 0f
        return true
    }

    /** Follows the gesture: 0 is where it started, 1 is the screen fully off to the right. */
    /** The innermost screen stack on screen that can pop: an app inside the shell before the shell. */
    private fun backTarget(): Int? {
        var best: Int? = null
        var bestLevel = -1
        for ((id, depth) in depths) {
            if (depth <= 1) continue
            val view = nodes[id]?.view ?: continue
            if (!view.isAttachedToWindow) continue
            var level = 0
            var v = view.parent
            while (v != null) {
                level++
                v = v.parent
            }
            if (level > bestLevel) {
                best = id
                bestLevel = level
            }
        }
        return best
    }

    fun updateInteractiveBack(progress: Float) {
        val snapshot = interactiveBack ?: return
        val root = nodes[interactiveTarget]?.view ?: return
        val p = progress.coerceIn(0f, 1f)
        interactiveProgress = p
        root.translationX = root.width * p
        snapshot.translationX = -root.width * 0.3f * (1 - p)
        interactiveDim?.alpha = (31 * (1 - p)).roundToInt()
    }

    /** Finishes the gesture. On commit, `pop` runs once the screen is off; the runtime's pop
     *  then swaps in the real previous screen exactly where its snapshot is. */
    fun endInteractiveBack(commit: Boolean, pop: () -> Unit) {
        val snapshot = interactiveBack ?: return
        ValueAnimator.ofFloat(interactiveProgress, if (commit) 1f else 0f).apply {
            duration = 220
            interpolator = PathInterpolator(0.2f, 0.8f, 0.2f, 1f)
            addUpdateListener { updateInteractiveBack(it.animatedValue as Float) }
            doOnEnd {
                if (commit) {
                    awaitingInteractivePop = interactiveTarget
                    pop()
                } else {
                    (snapshot.parent as? ViewGroup)?.removeView(snapshot)
                    nodes[interactiveTarget]?.view?.let { restoreRoot(it, interactiveTarget) }
                    interactiveBack = null
                }
            }
            start()
        }
    }

    private fun finishInteractivePop() {
        nodes[interactiveTarget]?.view?.let { restoreRoot(it, interactiveTarget) }
        interactiveBack?.let { (it.parent as? ViewGroup)?.removeView(it) }
        interactiveBack = null
        awaitingInteractivePop = 0
    }

    private fun restoreRoot(root: View, id: Int) {
        root.translationX = 0f
        nodes[id]?.let { root.background = it.background }
    }

    /**
     * Push: the new screen slides in from the right over the old one, which drifts left and dims.
     * Pop: the reverse. Fade (or animations off): a cross-fade.
     */
    private fun animateScreens(kind: String, style: String, duration: Long, root: View, snapshot: ImageView) {
        val w = root.width.toFloat()
        // The screens move inside the navigating root's parent: the surface, or an `app` node.
        val container = root.parent as? ViewGroup ?: surface
        val index = container.indexOfChild(root)
        val interpolator = PathInterpolator(0.2f, 0.8f, 0.2f, 1f)
        // The root is transparent outside its screen (the system bar bands); while it moves,
        // make it opaque so the old screen doesn't show through.
        val rootBackground = root.background
        root.background = ColorDrawable(screenBackground)
        val dim = ColorDrawable(Color.BLACK).apply { alpha = 0 }
        screensAnimating = true
        val done = {
            screensAnimating = false
            container.removeView(snapshot)
            root.background = rootBackground
            root.foreground = null
            root.translationX = 0f
        }
        if (style == "fade" || !animatorsEnabled()) {
            container.addView(snapshot, index + 1)
            snapshot.animate().alpha(0f).setDuration(duration).withEndAction(done)
        } else if (kind == "push") {
            container.addView(snapshot, index)
            snapshot.foreground = dim
            root.translationX = w
            root.animate().translationX(0f).setDuration(duration).setInterpolator(interpolator).withEndAction(done)
            snapshot.animate().translationX(-w * 0.3f).setDuration(duration).setInterpolator(interpolator)
            ObjectAnimator.ofInt(dim, "alpha", 0, 31).setDuration(duration).start()
        } else {
            container.addView(snapshot, index + 1)
            root.foreground = dim
            root.translationX = -w * 0.3f
            root.animate().translationX(0f).setDuration(duration).setInterpolator(interpolator).withEndAction(done)
            snapshot.animate().translationX(w).setDuration(duration).setInterpolator(interpolator)
            ObjectAnimator.ofInt(dim, "alpha", 31, 0).setDuration(duration).start()
        }
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
        "canvas" -> JigCanvasView(context)
        else -> JigLayout(context)
    }

    private fun render(node: Node) {
        val view = node.view
        val p = node.props
        val s = node.style
        val tr = transition(node)
        node.rendered = true

        // Box styling shared by every view type.
        val radius = (num(s["radius"]) ?: 0.0).toFloat() * density
        if (node.type != "toggle" && node.type != "textfield" || s.containsKey("background")) {
            val bg = node.background
            val target = color(s["background"]) ?: Color.TRANSPARENT
            if (target != node.backgroundColor) {
                node.colorAnimator?.cancel()
                if (tr != null) {
                    node.colorAnimator = ValueAnimator.ofArgb(node.backgroundColor, target).apply {
                        duration = tr.duration
                        interpolator = tr.interpolator
                        addUpdateListener { bg.setColor(it.animatedValue as Int) }
                        start()
                    }
                } else bg.setColor(target)
                node.backgroundColor = target
            }
            bg.cornerRadius = radius
            val border = ((num(s["borderWidth"]) ?: 0.0) * density).roundToInt()
            val borderColor = color(s["borderColor"]) ?: Color.TRANSPARENT
            if (node.type == "app") {
                // The embedded app covers the background, so its card's border goes in front.
                bg.setStroke(0, Color.TRANSPARENT)
                view.foreground = if (border > 0) GradientDrawable().apply {
                    cornerRadius = radius
                    setStroke(border, borderColor)
                } else null
            } else bg.setStroke(border, borderColor)
            view.background = bg
        }
        // Scroll views must always clip, or scrolled content draws over the header. Containers
        // don't clip their children (see JigLayout), so clipping comes from each view's own outline.
        view.clipToOutline = radius > 0 || node.type == "image" || node.type == "scroll" || node.type == "hscroll" || node.type == "canvas" || s["clip"] == true
        val alpha = (num(s["opacity"]) ?: 1.0).toFloat()
        if (tr != null && view.alpha != alpha) view.animate().alpha(alpha).setDuration(tr.duration).setInterpolator(tr.interpolator)
        else if (tr == null) view.alpha = alpha
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

        if (node.type == "app" && view is JigLayout) {
            // A whiteboard card is a picture of the app: touches go to the card.
            view.blocksTouches = p["interactive"] == false
            val scale = (num(p["contentScale"]) ?: 1.0).toFloat()
            for (i in 0 until view.childCount) view.getChildAt(i).takeIf { it.tag is Int }?.let { applyScale(it, scale) }
            // Select mode: a tap picks the deepest node under it instead of using it.
            view.onSelectTap = if (p["selecting"] == true) { x, y ->
                deepest(view, x, y)?.takeIf { it !== view }?.let {
                    view.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
                    dispatch?.invoke(it.tag as Int, "select", JSONObject())
                }
            } else null
        }
        setSelected(view, p["selected"] == true)
        if (view is JigLayout) {
            (p["swipeActions"] as? JSONArray)?.let { list ->
                rows.setActions(view, (0 until list.length()).map { i ->
                    val a = list.getJSONObject(i)
                    RowGestures.SwipeAction(a.optString("label"), color(a.opt("color")) ?: Color.RED)
                })
            }
            if (p["reorder"] == true) rows.setReorder(view, true)
        }

        when (node.type) {
            "text", "button" -> {
                val t = view as JigTextView
                t.setText(str(p[if (node.type == "button") "label" else "value"]), crossfade = tr?.duration ?: 0)
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
                    mono = s["fontFamily"] == "mono",
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
                // A secure field masks its text and stays out of suggestions and the keyboard's learning.
                val type = when {
                    p["secure"] == true -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                    p["keyboard"] == "number" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
                    else -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                }
                if (f.inputType != type) {
                    f.inputType = type
                    // A password input type switches the field to a monospace font; keep ours.
                    f.typeface = TextStyle.typeface((num(s["fontWeight"]) ?: 400.0).toInt())
                }
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
                val anim = tr?.let { it.duration to it.interpolator }
                shape.setColors(if (!p.containsKey("fill")) Color.BLACK else color(p["fill"]), color(p["stroke"]), anim)
                shape.setTrim((num(p["trimStart"]) ?: 0.0).toFloat(), (num(p["trimEnd"]) ?: 1.0).toFloat(), anim)
                shape.strokeWidth = (num(p["strokeWidth"]) ?: 1.0).toFloat()
                shape.lineCap = when (p["lineCap"]) {
                    "round" -> Paint.Cap.ROUND
                    "square" -> Paint.Cap.SQUARE
                    else -> Paint.Cap.BUTT
                }
            }
            "image" -> loadImage(str(p["src"]), view as ImageView, view.tag as Int)
            "scroll", "hscroll", "canvas" -> {
                if (view is JigHScrollView) {
                    // A paging hscroll (the builder's screen pager) reports the page it settles on.
                    view.paging = p["paging"] == true
                    if (view.paging && view.onPage == null) {
                        val id = view.tag as Int
                        view.onPage = { page -> dispatch?.invoke(id, "page", JSONObject().put("index", page)) }
                    }
                    (num(p["page"]))?.let { view.show(it.toInt(), animated = view.isLaidOut) }
                }
                // A long list inside needs the offset to know which rows to build.
                if (p["reportScroll"] == true && view is JigScrollView && reportingScroll.add(view.tag as Int)) {
                    val id = view.tag as Int
                    view.setOnScrollChangeListener { _, _, y, _, _ ->
                        dispatch?.invoke(id, "scroll", JSONObject().put("y", y / density.toDouble()))
                    }
                }
                val size = p["contentSize"] as? JSONArray ?: return
                val w = (size.getDouble(0) * density).roundToInt()
                val h = (size.getDouble(1) * density).roundToInt()
                when (view) {
                    is JigScrollView -> view.setContentSize(w, h)
                    is JigHScrollView -> view.setContentSize(w, h)
                    is JigCanvasView -> view.setContentSize(w, h)
                }
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
