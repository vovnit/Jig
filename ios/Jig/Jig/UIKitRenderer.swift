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
        init(type: String, view: UIView) {
            self.type = type
            self.view = view
        }
    }

    private var nodes: [Int: Node] = [:]

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
                insert(parent: parent, child: child, at: index)
            case "remove":
                guard op.count >= 3, let child = int(op[2]) else { continue }
                remove(id: child)
            case "frame":
                guard op.count >= 6, let id = int(op[1]), let node = nodes[id] else { continue }
                let f = CGRect(x: double(op[2]), y: double(op[3]), width: double(op[4]), height: double(op[5]))
                if node.view.frame != f { node.view.frame = f }
            case "command":
                guard op.count >= 3, let id = int(op[1]), let name = op[2] as? String else { continue }
                if name == "focus" { nodes[id]?.view.becomeFirstResponder() }
            default:
                continue
            }
        }
        // Layout may have moved the field (a new row, a viewport shrunk by the keyboard).
        revealFocusedField()
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

    private func insert(parent: Int, child: Int, at index: Int) {
        guard let p = nodes[parent], let c = nodes[child] else { return }
        let container = (p.view as? JigScrollView)?.content ?? p.view
        if c.view.superview === container, container.subviews.firstIndex(of: c.view) == index { return }
        c.view.removeFromSuperview()
        container.insertSubview(c.view, at: min(index, container.subviews.count))
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

        // Box styling shared by every view type.
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

        switch node.type {
        case "text":
            guard let label = view as? JigTextView else { return }
            label.insets = insets(s["padding"])
            label.text = NSAttributedString(string: string(p["value"]), attributes: textAttributes(s))
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
            shape.fill = p["fill"] == nil ? .black : color(p["fill"])
            shape.stroke = color(p["stroke"])
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
