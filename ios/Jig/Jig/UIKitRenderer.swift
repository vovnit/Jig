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

    init(surface: UIView) {
        self.surface = surface
        super.init()
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
        // A screen transition: keep a picture of the old screen to animate away from.
        let screenTransition = ops.first { $0.count >= 4 && ($0[0] as? String) == "command" && ($0[2] as? String) == "transition" }
        var snapshot: UIView?
        if screenTransition != nil, let root = nodes[1]?.view, root.window != nil {
            snapshot = root.snapshotView(afterScreenUpdates: false)
            snapshot?.frame = root.frame
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
                insert(parent: parent, child: child, at: index, animated: snapshot == nil)
            case "remove":
                guard op.count >= 3, let child = int(op[2]) else { continue }
                remove(id: child)
            case "frame":
                guard op.count >= 6, let id = int(op[1]), let node = nodes[id] else { continue }
                let f = CGRect(x: double(op[2]), y: double(op[3]), width: double(op[4]), height: double(op[5]))
                guard node.view.frame != f else { continue }
                if let t = transition(node), node.view.window != nil, !createdNow.contains(id) {
                    animate(t) { node.view.frame = f }
                } else {
                    node.view.frame = f
                }
            case "command":
                guard op.count >= 3, let id = int(op[1]), let name = op[2] as? String else { continue }
                if name == "focus" { nodes[id]?.view.becomeFirstResponder() }
            default:
                continue
            }
        }
        if let snapshot, let root = nodes[1]?.view, let args = screenTransition?[3] as? [Any], args.count >= 3 {
            animateScreens(kind: args[0] as? String ?? "push", style: args[1] as? String ?? "slide",
                           duration: double(args[2]) / 1000, root: root, snapshot: snapshot)
        }
        // Layout may have moved the field (a new row, a viewport shrunk by the keyboard).
        revealFocusedField()
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

    private func animate(_ t: Transition, _ changes: @escaping () -> Void) {
        let base: UIView.AnimationOptions = [.beginFromCurrentState, .allowUserInteraction]
        if t.easing == "spring" {
            UIView.animate(withDuration: t.duration, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0, options: base, animations: changes)
            return
        }
        let curve: UIView.AnimationOptions = switch t.easing {
        case "linear": .curveLinear
        case "easeIn": .curveEaseIn
        case "easeOut": .curveEaseOut
        default: .curveEaseInOut
        }
        UIView.animate(withDuration: t.duration, delay: 0, options: base.union(curve), animations: changes)
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
        let finish: (Bool) -> Void = { _ in
            snapshot.removeFromSuperview()
            dim.removeFromSuperview()
            root.backgroundColor = .clear
        }
        let slide = { (changes: @escaping () -> Void) in
            UIView.animate(withDuration: duration, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0,
                           options: [.allowUserInteraction], animations: changes, completion: finish)
        }
        if style == "fade" || UIAccessibility.isReduceMotionEnabled {
            surface.insertSubview(snapshot, aboveSubview: root)
            UIView.animate(withDuration: duration * 0.8, animations: { snapshot.alpha = 0 }, completion: finish)
        } else if kind == "push" {
            surface.insertSubview(snapshot, belowSubview: root)
            snapshot.addSubview(dim)
            root.transform = CGAffineTransform(translationX: width, y: 0)
            slide {
                root.transform = .identity
                snapshot.transform = CGAffineTransform(translationX: -width * 0.3, y: 0)
                dim.alpha = 0.12
            }
        } else {
            surface.insertSubview(snapshot, aboveSubview: root)
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
        if c.view.superview === container, container.subviews.firstIndex(of: c.view) == index { return }
        c.view.removeFromSuperview()
        container.insertSubview(c.view, at: min(index, container.subviews.count))
        // A node with a value transition fades in when it appears in an existing list.
        if animated, createdNow.contains(child), !createdNow.contains(parent), let t = transition(c) {
            let target = c.view.alpha
            c.view.alpha = 0
            animate(t) { c.view.alpha = target }
        }
    }

    private func remove(id: Int) {
        guard let node = nodes[id] else { return }
        node.view.removeFromSuperview()
        forget(node.view)
    }

    private func forget(_ view: UIView) {
        if view.tag > 0, nodes[view.tag]?.view === view { nodes.removeValue(forKey: view.tag) }
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
        case "scroll", "hscroll":
            let s = JigScrollView()
            if type == "hscroll" {
                s.alwaysBounceVertical = false
                s.alwaysBounceHorizontal = true
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
        case "scroll", "hscroll":
            guard let scroll = view as? JigScrollView, let size = p["contentSize"] as? [Any], size.count == 2 else { return }
            let content = CGSize(width: double(size[0]), height: double(size[1]))
            if scroll.contentSize != content { scroll.setContentSize(content) }
        default:
            break
        }
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
        if node.type != "shape" { view.clipsToBounds = radius > 0 || view is UIScrollView || node.type == "image" }
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

    // MARK: - Events

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
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
