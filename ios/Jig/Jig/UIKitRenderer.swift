import UIKit

/// The UIKit host: a "dumb" renderer that applies the runtime's ops. It creates
/// views by type, applies props and frames, and reports events by node id.
final class UIKitRenderer: NSObject, UIGestureRecognizerDelegate {
    /// Hosts the runtime's root node (id 1).
    let surface: UIView
    var dispatch: ((Int, String, [String: Any]) -> Void)?
    var accentColor = UIColor(red: 0.23, green: 0.43, blue: 0.96, alpha: 1)
    var isDark = false
    /// The text field being edited, kept visible above the keyboard.
    private weak var focusedField: UITextField?
    /// Swipe actions and drag-to-reorder on list rows.
    private let rows = RowGestures()

    private final class Node {
        let type: String
        let view: UIView
        var props: [String: Any] = [:]
        var style: [String: Any] = [:]
        /// Set after the first render: only later changes animate.
        var rendered = false
        init(type: String, view: UIView) {
            self.type = type
            self.view = view
        }
    }

    private var nodes: [Int: Node] = [:]
    /// Nodes created in the batch being applied: they appear without animating their frame.
    private var createdNow = Set<Int>()
    /// Removed views still fading out: they stay on screen but no longer count as children.
    private var leaving = Set<UIView>()

    /// Screen stacks, one per runtime root (the shell, or an app running inside it): the
    /// navigation depth, and what each screen below the current one looked like when it was
    /// left (taken on push), shown under the current screen during an interactive back swipe.
    private var depths: [Int: Int] = [:]
    private var screenSnapshots: [Int: [UIView?]] = [:]
    private var screensAnimating = false
    private var interactiveBack: (target: Int, snapshot: UIView, dim: UIView)?
    /// Set once a back swipe committed: the pop it causes (on this root) is already on screen.
    private var awaitingInteractivePop: Int?

    /// Whether any screen stack on screen can pop.
    var canGoBack: Bool { backTarget() != nil }

    init(surface: UIView) {
        self.surface = surface
        super.init()
        rows.dispatch = { [weak self] id, name, payload in self?.dispatch?(id, name, payload) }
        // One recognizer for every tappable node: walk up from the touched view to the
        // nearest tappable one, so a nested tappable (a delete icon in a row) wins.
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        surface.addGestureRecognizer(tap)
    }

    // MARK: - Ops

    func apply(json: String) {
        guard let data = json.data(using: .utf8),
              let ops = (try? JSONSerialization.jsonObject(with: data)) as? [[Any]]
        else { return }
        // A screen transition: keep a picture of the old screen to animate away from. The
        // command names the root of the runtime that navigated.
        let screenTransition = ops.first { $0.count >= 4 && ($0[0] as? String) == "command" && ($0[2] as? String) == "transition" }
        let target = screenTransition.flatMap { int($0[1]) }
        let interactivePop = target != nil && awaitingInteractivePop == target
        var snapshot: UIView?
        if let target, !interactivePop, let root = nodes[target]?.view, root.window != nil {
            snapshot = root.snapshotView(afterScreenUpdates: false)
            snapshot?.frame = frame(of: root)
        }
        createdNow.removeAll()
        for op in ops {
            guard let kind = op.first as? String else { continue }
            switch kind {
            case "create":
                guard op.count >= 4, let id = int(op[1]), let type = op[2] as? String else { continue }
                create(id: id, type: type, props: op[3] as? [String: Any] ?? [:])
            case "update":
                guard op.count >= 3, let id = int(op[1]) else { continue }
                update(id: id, props: op[2] as? [String: Any] ?? [:])
            case "insert":
                guard op.count >= 4, let parent = int(op[1]), let child = int(op[2]), let index = int(op[3]) else { continue }
                // A list row scrolling into its window (`quiet`) just appears.
                let quiet = op.count > 4 && (op[4] as? Bool) == true
                insert(parent: parent, child: child, at: index, animated: snapshot == nil && !interactivePop && !quiet)
            case "remove":
                guard op.count >= 3, let child = int(op[2]) else { continue }
                let quiet = op.count > 3 && (op[3] as? Bool) == true
                remove(id: child, animated: snapshot == nil && !interactivePop && !quiet)
            case "frame":
                guard op.count >= 6, let id = int(op[1]), let node = nodes[id] else { continue }
                let f = CGRect(x: double(op[2]), y: double(op[3]), width: double(op[4]), height: double(op[5]))
                guard frame(of: node.view) != f else { continue }
                // A dragged row takes its new place at once: the finger, not an animation, moves it.
                if let t = transition(node), node.view.window != nil, !createdNow.contains(id), !rows.isDragging(id) {
                    animate(t) { self.place(node.view, f) }
                } else {
                    place(node.view, f)
                }
                rows.framed(id)
                if let page = pendingPages.removeValue(forKey: id) { (node.view as? JigScrollView)?.show(page: page, animated: false) }
            case "command":
                guard op.count >= 3, let id = int(op[1]), let name = op[2] as? String else { continue }
                if name == "focus" { nodes[id]?.view.becomeFirstResponder() }
                if name == "depth", let args = op[3] as? [Any], let depth = args.first.flatMap(int) { depths[id] = depth }
            default:
                continue
            }
        }
        let args = screenTransition?[3] as? [Any] ?? []
        let kind = args.first as? String
        if interactivePop {
            finishInteractivePop()
        } else if let snapshot, let target, let root = nodes[target]?.view, args.count >= 3 {
            animateScreens(kind: kind ?? "push", style: args[1] as? String ?? "slide",
                           duration: double(args[2]) / 1000, root: root, snapshot: snapshot)
        }
        // Keep one snapshot per screen below the current one, for interactive back.
        if let target, kind == "push" { screenSnapshots[target, default: []].append(snapshot) }
        for (id, depth) in depths {
            var stack = screenSnapshots[id] ?? []
            while stack.count < depth - 1 { stack.append(nil) }
            while stack.count > max(0, depth - 1) { stack.removeLast() }
            screenSnapshots[id] = stack
        }
        // Layout may have moved the field (a new row, a viewport shrunk by the keyboard).
        revealFocusedField()
    }

    /// Sets a frame. A swiped or dragged row, or a scaled app, has a transform, which leaves
    /// `frame` undefined: place it by its bounds and anchor point instead.
    private func place(_ view: UIView, _ f: CGRect) {
        if view.transform.isIdentity {
            view.frame = f
        } else {
            view.bounds.size = f.size
            let a = view.layer.anchorPoint
            view.layer.position = CGPoint(x: f.minX + a.x * f.width, y: f.minY + a.y * f.height)
        }
    }

    private func frame(of view: UIView) -> CGRect {
        if view.transform.isIdentity { return view.frame }
        let size = view.bounds.size
        let a = view.layer.anchorPoint
        let p = view.layer.position
        return CGRect(x: p.x - a.x * size.width, y: p.y - a.y * size.height, width: size.width, height: size.height)
    }

    /// An embedded app's root, drawn at its `app` node's scale from the top left.
    private func applyScale(_ view: UIView, _ scale: CGFloat) {
        let f = frame(of: view)
        view.layer.anchorPoint = .zero
        view.transform = scale == 1 ? .identity : CGAffineTransform(scaleX: scale, y: scale)
        place(view, f)
    }

    // MARK: - Transitions

    private struct Transition {
        let duration: TimeInterval
        let easing: String
    }

    /// The node's `style.transition` for a change after its first render, unless Reduce Motion is on.
    private func transition(_ node: Node) -> Transition? {
        guard node.rendered, !UIAccessibility.isReduceMotionEnabled,
              let t = node.style["transition"] as? [String: Any],
              let ms = (t["duration"] as? NSNumber)?.doubleValue, ms > 0
        else { return nil }
        return Transition(duration: ms / 1000, easing: t["easing"] as? String ?? "ease")
    }

    private func animate(_ t: Transition, _ changes: @escaping () -> Void, completion: ((Bool) -> Void)? = nil) {
        let base: UIView.AnimationOptions = [.beginFromCurrentState, .allowUserInteraction]
        if t.easing == "spring" {
            UIView.animate(withDuration: t.duration, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0, options: base, animations: changes, completion: completion)
            return
        }
        let curve: UIView.AnimationOptions = switch t.easing {
        case "linear": .curveLinear
        case "easeIn": .curveEaseIn
        case "easeOut": .curveEaseOut
        default: .curveEaseInOut
        }
        UIView.animate(withDuration: t.duration, delay: 0, options: base.union(curve), animations: changes, completion: completion)
    }

    private func timing(_ t: Transition) -> CAMediaTimingFunction {
        switch t.easing {
        case "linear": CAMediaTimingFunction(name: .linear)
        case "easeIn": CAMediaTimingFunction(name: .easeIn)
        case "easeOut", "spring": CAMediaTimingFunction(name: .easeOut)
        default: CAMediaTimingFunction(name: .easeInEaseOut)
        }
    }

    /// Push: the new screen slides in from the right over the old one, which drifts left and dims.
    /// Pop: the reverse. Fade (or Reduce Motion): a cross-dissolve.
    private func animateScreens(kind: String, style: String, duration: TimeInterval, root: UIView, snapshot: UIView) {
        let width = root.bounds.width
        // The root is transparent outside its screen (the safe-area bands); while it moves, make
        // it opaque so the old screen doesn't show through.
        root.backgroundColor = surface.backgroundColor
        let dim = UIView(frame: snapshot.bounds)
        dim.backgroundColor = .black
        dim.alpha = 0
        dim.isUserInteractionEnabled = false
        screensAnimating = true
        let finish: (Bool) -> Void = { [weak self] _ in
            snapshot.removeFromSuperview()
            dim.removeFromSuperview()
            // A push snapshot is kept for interactive back, so leave it reusable.
            snapshot.transform = .identity
            snapshot.alpha = 1
            root.backgroundColor = .clear
            self?.screensAnimating = false
        }
        let slide = { (changes: @escaping () -> Void) in
            UIView.animate(withDuration: duration, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0,
                           options: [.allowUserInteraction], animations: changes, completion: finish)
        }
        // The screens move inside the navigating root's parent: the surface, or an `app` node.
        let container = root.superview ?? surface
        if style == "fade" || UIAccessibility.isReduceMotionEnabled {
            container.insertSubview(snapshot, aboveSubview: root)
            UIView.animate(withDuration: duration * 0.8, animations: { snapshot.alpha = 0 }, completion: finish)
        } else if kind == "push" {
            container.insertSubview(snapshot, belowSubview: root)
            snapshot.addSubview(dim)
            root.transform = CGAffineTransform(translationX: width, y: 0)
            slide {
                root.transform = .identity
                snapshot.transform = CGAffineTransform(translationX: -width * 0.3, y: 0)
                dim.alpha = 0.12
            }
        } else {
            container.insertSubview(snapshot, aboveSubview: root)
            dim.frame = root.bounds
            dim.alpha = 0.12
            root.addSubview(dim)
            root.transform = CGAffineTransform(translationX: -width * 0.3, y: 0)
            slide {
                root.transform = .identity
                snapshot.transform = CGAffineTransform(translationX: width, y: 0)
                dim.alpha = 0
            }
        }
    }

    // MARK: - Interactive back

    /// Starts a back swipe: the previous screen's snapshot appears under the current one.
    /// Returns false when there is nothing to swipe back to, or no picture of it.
    func beginInteractiveBack() -> Bool {
        guard !screensAnimating, interactiveBack == nil, awaitingInteractivePop == nil,
              let target = backTarget(), let root = nodes[target]?.view, let snapshot = screenSnapshots[target]?.last ?? nil
        else { return false }
        surface.endEditing(true)
        snapshot.frame = frame(of: root)
        snapshot.transform = CGAffineTransform(translationX: -root.bounds.width * 0.3, y: 0)
        let dim = UIView(frame: snapshot.bounds)
        dim.backgroundColor = .black
        dim.alpha = 0.12
        dim.isUserInteractionEnabled = false
        snapshot.addSubview(dim)
        (root.superview ?? surface).insertSubview(snapshot, belowSubview: root)
        root.backgroundColor = surface.backgroundColor
        interactiveBack = (target, snapshot, dim)
        return true
    }

    /// The innermost screen stack on screen that can pop: an app inside the shell before the shell.
    private func backTarget() -> Int? {
        var best: (id: Int, level: Int)?
        for (id, depth) in depths where depth > 1 {
            guard let view = nodes[id]?.view, view.window != nil else { continue }
            var level = 0
            var v = view.superview
            while let current = v {
                level += 1
                v = current.superview
            }
            if best == nil || level > best!.level { best = (id, level) }
        }
        return best?.id
    }

    /// Follows the finger: 0 is where the swipe started, 1 is the screen fully off to the right.
    func updateInteractiveBack(progress: CGFloat) {
        guard let (target, snapshot, dim) = interactiveBack, let root = nodes[target]?.view else { return }
        let p = min(1, max(0, progress))
        let width = root.bounds.width
        root.transform = CGAffineTransform(translationX: width * p, y: 0)
        snapshot.transform = CGAffineTransform(translationX: -width * 0.3 * (1 - p), y: 0)
        dim.alpha = 0.12 * (1 - p)
    }

    /// Finishes the swipe. On commit, `pop` runs once the screen is off; the runtime's pop
    /// then swaps in the real previous screen exactly where its snapshot is.
    func endInteractiveBack(commit: Bool, pop: @escaping () -> Void) {
        guard let (target, snapshot, dim) = interactiveBack, let root = nodes[target]?.view else { return }
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
            self.updateInteractiveBack(progress: commit ? 1 : 0)
        } completion: { _ in
            if commit {
                self.awaitingInteractivePop = target
                pop()
            } else {
                snapshot.removeFromSuperview()
                dim.removeFromSuperview()
                snapshot.transform = .identity
                root.backgroundColor = .clear
                self.interactiveBack = nil
            }
        }
    }

    private func finishInteractivePop() {
        guard let (target, snapshot, dim) = interactiveBack else { return }
        nodes[target]?.view.transform = .identity
        nodes[target]?.view.backgroundColor = .clear
        snapshot.removeFromSuperview()
        dim.removeFromSuperview()
        snapshot.transform = .identity
        interactiveBack = nil
        awaitingInteractivePop = nil
    }

    func revealFocusedField(animated: Bool = true) {
        guard let field = focusedField, field.window != nil else { return }
        var v = field.superview
        while let current = v, !(current is JigScrollView) { v = current.superview }
        guard let scroll = v as? JigScrollView else { return }
        let rect = field.convert(field.bounds, to: scroll).insetBy(dx: 0, dy: -16)
        let visible = CGRect(origin: scroll.contentOffset, size: scroll.bounds.size)
        if !visible.contains(rect) { scroll.scrollRectToVisible(rect, animated: animated) }
    }

    private func create(id: Int, type: String, props: [String: Any]) {
        let view = makeView(id: id, type: type)
        view.tag = id
        let node = Node(type: type, view: view)
        nodes[id] = node
        createdNow.insert(id)
        if type == "root" {
            // Below any native chrome the host adds on the surface (the app switcher).
            surface.subviews.filter { $0.tag > 0 }.forEach { $0.removeFromSuperview() }
            surface.insertSubview(view, at: 0)
        }
        update(id: id, props: props)
    }

    private func update(id: Int, props: [String: Any]) {
        guard let node = nodes[id] else { return }
        for (k, v) in props {
            if k == "style", let s = v as? [String: Any] {
                for (sk, sv) in s {
                    if sv is NSNull { node.style.removeValue(forKey: sk) } else { node.style[sk] = sv }
                }
            } else if v is NSNull {
                node.props.removeValue(forKey: k)
            } else {
                node.props[k] = v
            }
        }
        render(node)
    }

    private func insert(parent: Int, child: Int, at index: Int, animated: Bool) {
        guard let p = nodes[parent], let c = nodes[child] else { return }
        let container = (p.view as? JigScrollView)?.content ?? p.view
        // Indexes count live children only: views still fading out (and a row's swipe actions) are skipped.
        let live = container.subviews.filter { !leaving.contains($0) && $0.tag > 0 }
        if c.view.superview === container, live.firstIndex(of: c.view) == index { return }
        let siblings = live.filter { $0 !== c.view }
        c.view.removeFromSuperview()
        if index < siblings.count { container.insertSubview(c.view, belowSubview: siblings[index]) } else { container.addSubview(c.view) }
        if let scale = cgFloat(p.props["contentScale"]), scale != 1 { applyScale(c.view, scale) }
        if let catcher = selectCatchers[parent] { container.bringSubviewToFront(catcher) }
        // A node with a value transition fades in when it appears in an existing list.
        if animated, createdNow.contains(child), !createdNow.contains(parent), let t = transition(c) {
            let target = c.view.alpha
            c.view.alpha = 0
            animate(t) { c.view.alpha = target }
        }
    }

    private func remove(id: Int, animated: Bool) {
        guard let node = nodes[id] else { return }
        let view = node.view
        forget(view)
        // A node with a value transition fades out in place, above the siblings moving into its spot.
        if animated, view.window != nil, let t = transition(node) {
            leaving.insert(view)
            view.isUserInteractionEnabled = false
            view.superview?.bringSubviewToFront(view)
            animate(t, { view.alpha = 0 }) { [weak self] _ in
                view.removeFromSuperview()
                self?.leaving.remove(view)
            }
            return
        }
        view.removeFromSuperview()
    }

    private func forget(_ view: UIView) {
        if view.tag > 0, nodes[view.tag]?.view === view {
            nodes.removeValue(forKey: view.tag)
            rows.forget(view.tag)
            depths.removeValue(forKey: view.tag)
            screenSnapshots.removeValue(forKey: view.tag)
            selectCatchers.removeValue(forKey: view.tag)
            selectionViews.removeValue(forKey: view.tag)
            pendingPages.removeValue(forKey: view.tag)
        }
        for sub in view.subviews { forget(sub) }
    }

    // MARK: - Views

    private func makeView(id: Int, type: String) -> UIView {
        switch type {
        case "text":
            return JigTextView()
        case "button":
            let b = JigButton(type: .custom)
            b.titleLabel?.numberOfLines = 0
            b.titleLabel?.textAlignment = .center
            b.addAction(UIAction { [weak self] _ in self?.dispatch?(id, "tap", [:]) }, for: .touchUpInside)
            return b
        case "textfield":
            let f = JigTextField()
            f.borderStyle = .none
            f.addAction(UIAction { [weak self, weak f] _ in
                self?.dispatch?(id, "change", ["value": f?.text ?? ""])
            }, for: .editingChanged)
            f.addAction(UIAction { [weak self] _ in self?.dispatch?(id, "submit", [:]) }, for: .primaryActionTriggered)
            f.addAction(UIAction { [weak self, weak f] _ in
                self?.focusedField = f
                self?.revealFocusedField()
            }, for: .editingDidBegin)
            f.addAction(UIAction { [weak self, weak f] _ in
                if self?.focusedField === f { self?.focusedField = nil }
            }, for: .editingDidEnd)
            return f
        case "toggle":
            let s = UISwitch()
            s.addAction(UIAction { [weak self, weak s] _ in
                self?.dispatch?(id, "change", ["value": s?.isOn ?? false])
            }, for: .valueChanged)
            return s
        case "shape":
            return JigShapeView()
        case "image":
            let v = UIImageView()
            v.contentMode = .scaleAspectFill
            v.clipsToBounds = true
            return v
        case "scroll", "hscroll", "canvas":
            let s = JigScrollView()
            if type == "hscroll" {
                s.alwaysBounceVertical = false
                s.alwaysBounceHorizontal = true
            }
            if type == "canvas" {
                s.alwaysBounceHorizontal = true
                s.zoomable = true
            }
            return s
        default:
            return UIView()
        }
    }

    private func render(_ node: Node) {
        let view = node.view
        let p = node.props
        let s = node.style

        let t = transition(node)
        node.rendered = true
        if let t { animate(t) { self.renderBox(node) } } else { renderBox(node) }

        switch node.type {
        case "text":
            guard let label = view as? JigTextView else { return }
            label.insets = insets(s["padding"])
            let text = NSAttributedString(string: string(p["value"]), attributes: textAttributes(s))
            if let t, label.text != text {
                UIView.transition(with: label, duration: t.duration, options: [.transitionCrossDissolve, .beginFromCurrentState]) { label.text = text }
            } else {
                label.text = text
            }
        case "button":
            guard let button = view as? UIButton else { return }
            button.setAttributedTitle(NSAttributedString(string: string(p["label"]), attributes: textAttributes(s, defaultAlign: .center)), for: .normal)
            button.accessibilityLabel = string(p["label"])
        case "textfield":
            guard let field = view as? JigTextField else { return }
            field.insets = insets(s["padding"])
            let attrs = textAttributes(s)
            field.font = attrs[.font] as? UIFont
            field.textColor = attrs[.foregroundColor] as? UIColor
            field.tintColor = accentColor
            field.attributedPlaceholder = NSAttributedString(
                string: string(p["placeholder"]),
                attributes: [.font: attrs[.font] as Any, .foregroundColor: UIColor.placeholderText]
            )
            field.keyboardType = (p["keyboard"] as? String) == "number" ? .decimalPad : .default
            // A secure field masks its text and keeps it out of autocorrect and the clipboard.
            let secure = (p["secure"] as? Bool) ?? false
            if field.isSecureTextEntry != secure {
                field.isSecureTextEntry = secure
                field.autocorrectionType = secure ? .no : .default
                field.textContentType = secure ? .password : nil
            }
            field.keyboardAppearance = isDark ? .dark : .light
            // Native owns the text while the user types; only apply values from the runtime that differ.
            let value = string(p["value"])
            if field.text != value { field.text = value }
        case "toggle":
            guard let toggle = view as? UISwitch else { return }
            toggle.onTintColor = accentColor
            let on = (p["value"] as? Bool) ?? false
            if toggle.isOn != on { toggle.setOn(on, animated: true) }
        case "shape":
            guard let shape = view as? JigShapeView else { return }
            shape.pathData = string(p["path"])
            shape.viewBox = viewBox(p["viewBox"])
            let animation = t.map { (duration: $0.duration, timing: timing($0)) }
            shape.setColors(fill: p["fill"] == nil ? .black : color(p["fill"]), stroke: color(p["stroke"]), animation: animation)
            shape.setTrim(start: cgFloat(p["trimStart"]) ?? 0, end: cgFloat(p["trimEnd"]) ?? 1, animation: animation)
            shape.strokeWidth = cgFloat(p["strokeWidth"]) ?? 1
            shape.lineCap = (p["lineCap"] as? String) == "round" ? .round : (p["lineCap"] as? String) == "square" ? .square : .butt
        case "image":
            guard let imageView = view as? UIImageView else { return }
            loadImage(string(p["src"]), into: imageView, id: view.tag)
        case "scroll", "hscroll", "canvas":
            guard let scroll = view as? JigScrollView else { return }
            // A paging hscroll (the builder's screen pager) reports the page it settles on.
            scroll.isPagingEnabled = p["paging"] as? Bool == true
            if scroll.isPagingEnabled, scroll.onPage == nil {
                let id = view.tag
                scroll.onPage = { [weak self] page in self?.dispatch?(id, "page", ["index": page]) }
            }
            if let page = p["page"].flatMap(int) {
                // Before its first frame the scroll view has no width to page by: wait for it.
                if scroll.bounds.width > 0 { scroll.show(page: page, animated: true) } else { pendingPages[view.tag] = page }
            }
            // A long list inside needs the offset to know which rows to build.
            if p["reportScroll"] as? Bool == true, scroll.onScroll == nil {
                let id = view.tag
                scroll.onScroll = { [weak self, weak scroll] y in
                    self?.dispatch?(id, "scroll", ["y": Double(y)])
                    if scroll?.isTracking == true { self?.rows.closeOpen() }
                }
            }
            guard let size = p["contentSize"] as? [Any], size.count == 2 else { break }
            scroll.setContentSize(CGSize(width: double(size[0]), height: double(size[1])))
        default:
            break
        }
        if node.type == "app" {
            // A whiteboard card is a picture of the app: touches go to the card.
            view.isUserInteractionEnabled = p["interactive"] as? Bool != false
            let scale = cgFloat(p["contentScale"]) ?? 1
            for sub in view.subviews where sub.tag > 0 && sub.transform.a != scale { applyScale(sub, scale) }
            setSelecting(view, p["selecting"] as? Bool == true)
        }
        setSelected(view, p["selected"] as? Bool == true)
        if let list = p["swipeActions"] as? [[String: Any]] {
            rows.setActions(id: view.tag, view: view, actions: list.map {
                RowGestures.SwipeAction(label: string($0["label"]), color: color($0["color"]) ?? .systemRed)
            })
        }
        if p["reorder"] as? Bool == true { rows.setReorder(id: view.tag, view: view, on: true) }
        if node.type != "text" { view.isAccessibilityElement = p["tappable"] as? Bool == true }
        if p["tappable"] as? Bool == true { view.accessibilityTraits.insert(.button) }
    }

    /// Box styling shared by every view type; runs inside an animation block for value transitions.
    private func renderBox(_ node: Node) {
        let view = node.view
        let s = node.style
        let radius = cgFloat(s["radius"]) ?? 0
        view.layer.cornerRadius = radius
        // Scroll views must always clip, or scrolled content draws over the header.
        if node.type != "shape" { view.clipsToBounds = radius > 0 || view is UIScrollView || node.type == "image" || s["clip"] as? Bool == true }
        view.layer.borderWidth = cgFloat(s["borderWidth"]) ?? 0
        view.layer.borderColor = color(s["borderColor"])?.cgColor
        view.alpha = cgFloat(s["opacity"]) ?? 1
        // Explicitly clear: a nil background on an opaque-drawing view (UILabel) renders black.
        if node.type != "toggle" { view.backgroundColor = color(s["background"]) ?? .clear }
        if s["shadow"] as? Bool == true || (s["shadow"] as? String).map({ !$0.isEmpty }) == true {
            view.layer.shadowColor = UIColor.black.cgColor
            view.layer.shadowOpacity = 0.1
            view.layer.shadowRadius = 8
            view.layer.shadowOffset = CGSize(width: 0, height: 3)
            view.clipsToBounds = false
        } else {
            view.layer.shadowOpacity = 0
        }

    }

    // MARK: - Screenshots (the builder)

    /// A PNG of a node's view at its own size, one pixel per point (an app in a scaled card is drawn unscaled).
    func snapshot(id: Int) -> Data? {
        guard let view = nodes[id]?.view, view.bounds.width > 0, view.bounds.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: view.bounds.size, format: format).image { context in
            (surface.backgroundColor ?? .white).setFill()
            context.fill(CGRect(origin: .zero, size: view.bounds.size))
            view.layer.render(in: context.cgContext)
        }
        return image.pngData()
    }

    // MARK: - Select mode (the builder)

    private var pendingPages: [Int: Int] = [:]
    private var selectCatchers: [Int: UIView] = [:]
    private var selectionViews: [Int: UIView] = [:]

    /// In select mode a tap inside an app picks the part under it instead of using it: a
    /// transparent view on top takes the touches and reports the deepest node there.
    private func setSelecting(_ appView: UIView, _ on: Bool) {
        let id = appView.tag
        if !on {
            selectCatchers.removeValue(forKey: id)?.removeFromSuperview()
            return
        }
        guard selectCatchers[id] == nil else { return }
        let catcher = UIView(frame: appView.bounds)
        catcher.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        catcher.backgroundColor = .clear
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleSelectTap(_:)))
        catcher.addGestureRecognizer(tap)
        appView.addSubview(catcher)
        selectCatchers[id] = catcher
    }

    @objc private func handleSelectTap(_ gesture: UITapGestureRecognizer) {
        guard let catcher = gesture.view, let appView = catcher.superview else { return }
        catcher.isHidden = true
        defer { catcher.isHidden = false }
        let point = gesture.location(in: appView)
        var hit = appView.hitTest(point, with: nil)
        while let v = hit, v !== appView {
            if v.tag > 0, nodes[v.tag]?.view === v {
                UISelectionFeedbackGenerator().selectionChanged()
                dispatch?(v.tag, "select", [:])
                return
            }
            hit = v.superview
        }
    }

    /// The selected node's outline, in the accent color, inside its bounds so a clipping view shows it too.
    private func setSelected(_ view: UIView, _ on: Bool) {
        let id = view.tag
        if !on {
            selectionViews.removeValue(forKey: id)?.removeFromSuperview()
            return
        }
        let outline = selectionViews[id] ?? UIView()
        outline.frame = view.bounds
        outline.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        outline.isUserInteractionEnabled = false
        outline.layer.borderWidth = 2
        outline.layer.borderColor = accentColor.cgColor
        outline.layer.cornerRadius = max(view.layer.cornerRadius, 4)
        if outline.superview == nil { view.addSubview(outline) }
        selectionViews[id] = outline
    }

    // MARK: - Events

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        // Touching anything closes an open row instead; a drag's touch ending isn't a tap.
        if rows.closeOpen() || CACurrentMediaTime() - rows.endedAt < 0.3 { return }
        let point = gesture.location(in: surface)
        var view = surface.hitTest(point, with: nil)
        if !(view is UITextField) { surface.endEditing(true) }
        while let v = view, v !== surface {
            if v.tag > 0, let node = nodes[v.tag], node.view === v, node.props["tappable"] as? Bool == true {
                UIView.animate(withDuration: 0.08, animations: { v.alpha = 0.6 }) { _ in
                    UIView.animate(withDuration: 0.15) { v.alpha = self.cgFloat(node.style["opacity"]) ?? 1 }
                }
                dispatch?(v.tag, "tap", [:])
                return
            }
            view = v.superview
        }
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Buttons, switches and fields handle their own touches. Check both the touched view
        // and a hit test at the touch location: a control's touch view can sit outside its subtree.
        !isInsideControl(touch.view) && !isInsideControl(surface.hitTest(touch.location(in: surface), with: nil))
    }

    private func isInsideControl(_ view: UIView?) -> Bool {
        var v = view
        while let current = v, current !== surface {
            if current is UIControl { return true }
            v = current.superview
        }
        return false
    }

    // MARK: - Images

    private var imageSources: [Int: String] = [:]

    private func loadImage(_ src: String, into view: UIImageView, id: Int) {
        guard imageSources[id] != src else { return }
        imageSources[id] = src
        view.image = nil
        let report: (UIImage) -> Void = { [weak self, weak view] image in
            guard let self, let view, self.imageSources[id] == src else { return }
            view.image = image
            self.dispatch?(id, "load", ["width": Double(image.size.width), "height": Double(image.size.height)])
        }
        if let bundled = UIImage(named: src) {
            report(bundled)
            return
        }
        if src.hasPrefix("data:"), let comma = src.firstIndex(of: ","),
           let data = Data(base64Encoded: String(src[src.index(after: comma)...])), let image = UIImage(data: data) {
            report(image)
            return
        }
        guard let url = URL(string: src), url.scheme == "https" || url.scheme == "http" else { return }
        Task {
            guard let (data, _) = try? await URLSession.shared.data(from: url), let image = UIImage(data: data) else { return }
            report(image)
        }
    }

    // MARK: - Values

    private func textAttributes(_ s: [String: Any], defaultAlign: NSTextAlignment = .natural) -> [NSAttributedString.Key: Any] {
        let align: NSTextAlignment = switch s["textAlign"] as? String {
        case "center": .center
        case "right", "end": .right
        case "left", "start": .left
        default: defaultAlign
        }
        return TextStyle.attributes(
            size: double(s["fontSize"] ?? 17),
            weight: double(s["fontWeight"] ?? 400),
            lineHeight: double(s["lineHeight"] ?? 22),
            mono: s["fontFamily"] as? String == "mono",
            color: color(s["color"]) ?? .black,
            align: align
        )
    }

    private func insets(_ v: Any?) -> UIEdgeInsets {
        guard let a = v as? [Any], a.count == 4 else { return .zero }
        return UIEdgeInsets(top: double(a[0]), left: double(a[3]), bottom: double(a[2]), right: double(a[1]))
    }

    private func viewBox(_ v: Any?) -> CGRect {
        let parts = string(v).split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
        guard parts.count == 4 else { return CGRect(x: 0, y: 0, width: 24, height: 24) }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }

    private func color(_ v: Any?) -> UIColor? { (v as? String).flatMap { UIColor(hex: $0) } }
    private func string(_ v: Any?) -> String { v.map { $0 is NSNull ? "" : "\($0)" } ?? "" }
    private func int(_ v: Any) -> Int? { (v as? NSNumber)?.intValue }
    private func double(_ v: Any) -> Double { (v as? NSNumber)?.doubleValue ?? Double("\(v)") ?? 0 }
    private func cgFloat(_ v: Any?) -> CGFloat? { v.flatMap { ($0 as? NSNumber).map { CGFloat($0.doubleValue) } } }
}
