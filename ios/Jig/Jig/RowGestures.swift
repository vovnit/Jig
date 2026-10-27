import UIKit

/// List row gestures: swipe a row left to reveal its actions, long-press it to drag and
/// reorder. The runtime owns the order: a dragged row reports each neighbour it passes
/// ("move"), the runtime reorders the items and sends new frames, and the row stays under
/// the finger meanwhile while its siblings animate into place.
final class RowGestures: NSObject, UIGestureRecognizerDelegate {
    struct SwipeAction {
        let label: String
        let color: UIColor
    }

    var dispatch: ((Int, String, [String: Any]) -> Void)?

    private var actions: [Int: [SwipeAction]] = [:]
    private var reorderable = Set<Int>()
    private var rows: [Int: UIView] = [:]
    private var open: (id: Int, row: UIView, panel: UIView, width: CGFloat)?
    private var swipe: (id: Int, row: UIView, panel: UIView, base: CGFloat)?
    private var drag: Drag?
    /// A drag just ended: the tap recognizer sees its touch end too.
    private(set) var endedAt: CFTimeInterval = 0

    private final class Drag {
        let id: Int
        let row: UIView
        let gesture: UILongPressGestureRecognizer
        let start: CGFloat
        let home: CGFloat
        let scroll: UIScrollView?
        var pendingAt: CFTimeInterval = 0
        var link: CADisplayLink?
        init(id: Int, row: UIView, gesture: UILongPressGestureRecognizer, start: CGFloat, home: CGFloat, scroll: UIScrollView?) {
            self.id = id
            self.row = row
            self.gesture = gesture
            self.start = start
            self.home = home
            self.scroll = scroll
        }
    }

    // MARK: - Renderer API

    func setActions(id: Int, view: UIView, actions list: [SwipeAction]) {
        actions[id] = list.isEmpty ? nil : list
        attach(id: id, view: view)
    }

    func setReorder(id: Int, view: UIView, on: Bool) {
        if on { reorderable.insert(id) } else { reorderable.remove(id) }
        attach(id: id, view: view)
    }

    func isDragging(_ id: Int) -> Bool { drag?.id == id }

    /// The runtime moved a row: keep a dragged row under the finger, and an open row's actions beside it.
    func framed(_ id: Int) {
        if let d = drag, d.id == id {
            d.pendingAt = 0
            position(d)
        }
        if let o = open, o.id == id { o.panel.frame = untransformedFrame(o.row) }
    }

    func forget(_ id: Int) {
        actions.removeValue(forKey: id)
        reorderable.remove(id)
        rows.removeValue(forKey: id)
        if open?.id == id {
            open?.panel.removeFromSuperview()
            open = nil
        }
        if drag?.id == id { finishDrag(animated: false) }
    }

    /// Closes an open row. Returns true if one was open: the touch that closed it isn't a tap.
    @discardableResult
    func closeOpen() -> Bool {
        guard let o = open else { return false }
        open = nil
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
            o.row.transform = .identity
        } completion: { _ in
            o.panel.removeFromSuperview()
        }
        return true
    }

    private func attach(id: Int, view: UIView) {
        guard rows[id] !== view else { return }
        rows[id] = view
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.delegate = self
        view.addGestureRecognizer(pan)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(handlePress(_:)))
        press.minimumPressDuration = 0.4
        press.delegate = self
        view.addGestureRecognizer(press)
    }

    // MARK: - Gesture delegate

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard let id = g.view?.tag else { return false }
        if let pan = g as? UIPanGestureRecognizer {
            // Horizontal swipes only; vertical drags scroll.
            guard actions[id] != nil, drag == nil else { return false }
            let v = pan.velocity(in: g.view)
            return abs(v.x) > abs(v.y) && (v.x < 0 || open?.id == id)
        }
        return reorderable.contains(id) && swipe == nil
    }

    // MARK: - Swipe

    @objc private func handlePan(_ g: UIPanGestureRecognizer) {
        guard let row = g.view else { return }
        let id = row.tag
        switch g.state {
        case .began:
            let reopening = open?.id == id ? open : nil
            if open != nil, reopening == nil { closeOpen() }
            open = nil
            let panel = reopening?.panel ?? makePanel(id: id, row: row)
            swipe = (id, row, panel, reopening.map { -$0.width } ?? 0)
        case .changed:
            guard let s = swipe else { return }
            let width = row.bounds.width
            var tx = s.base + g.translation(in: row.superview).x
            // Rubber band past the edges.
            if tx > 0 { tx /= 4 }
            if tx < -width { tx = -width - (-width - tx) / 4 }
            row.transform = CGAffineTransform(translationX: tx, y: 0)
        case .ended, .cancelled, .failed:
            guard let s = swipe else { return }
            swipe = nil
            let width = row.bounds.width
            let tx = row.transform.tx + g.velocity(in: row.superview).x * 0.1
            let actionsWidth = panelWidth(s.panel)
            let springs = { (to: CGFloat, done: @escaping () -> Void) in
                UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                    row.transform = to == 0 ? .identity : CGAffineTransform(translationX: to, y: 0)
                } completion: { _ in done() }
            }
            if g.state == .ended, tx < -width * 0.6 {
                // A full swipe runs the first action.
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                springs(-width) {
                    s.panel.removeFromSuperview()
                    self.dispatch?(id, "swipe", ["index": 0])
                    // If the action kept the row, bring it back.
                    UIView.animate(withDuration: 0.25) { row.transform = .identity }
                }
            } else if g.state == .ended, tx < -actionsWidth / 2 {
                open = (id, row, s.panel, actionsWidth)
                springs(-actionsWidth) {}
            } else {
                springs(0) { s.panel.removeFromSuperview() }
            }
        default:
            break
        }
    }

    /// The actions sit behind the row, right-aligned, and show as the row slides away.
    private func makePanel(id: Int, row: UIView) -> UIView {
        let panel = UIView(frame: untransformedFrame(row))
        panel.clipsToBounds = true
        var x = panel.bounds.width
        for (index, a) in (actions[id] ?? []).enumerated().reversed() {
            let b = UIButton(type: .system)
            b.setTitle(a.label, for: .normal)
            b.setTitleColor(.white, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
            b.backgroundColor = a.color
            let w = max(74, b.intrinsicContentSize.width + 32)
            x -= w
            b.frame = CGRect(x: x, y: 0, width: w, height: panel.bounds.height)
            b.autoresizingMask = [.flexibleLeftMargin, .flexibleHeight]
            b.addAction(UIAction { [weak self] _ in
                self?.dispatch?(id, "swipe", ["index": index])
                self?.closeOpen()
            }, for: .touchUpInside)
            panel.addSubview(b)
        }
        row.superview?.insertSubview(panel, belowSubview: row)
        return panel
    }

    private func panelWidth(_ panel: UIView) -> CGFloat {
        panel.subviews.reduce(0) { $0 + $1.frame.width }
    }

    // MARK: - Drag

    @objc private func handlePress(_ g: UILongPressGestureRecognizer) {
        guard let row = g.view, let body = row.superview else { return }
        switch g.state {
        case .began:
            closeOpen()
            var scroll: UIScrollView?
            var v = body.superview
            while let current = v, scroll == nil {
                scroll = current as? UIScrollView
                v = current.superview
            }
            let d = Drag(id: row.tag, row: row, gesture: g, start: g.location(in: body).y, home: untransformedFrame(row).minY, scroll: scroll)
            drag = d
            // The scroll view must not scroll under the finger while the row follows it.
            scroll?.panGestureRecognizer.isEnabled = false
            scroll?.panGestureRecognizer.isEnabled = true
            row.layer.zPosition = 1
            row.layer.shadowColor = UIColor.black.cgColor
            row.layer.shadowRadius = 12
            row.layer.shadowOffset = CGSize(width: 0, height: 6)
            UIView.animate(withDuration: 0.2) {
                row.layer.shadowOpacity = 0.18
                self.position(d)
            }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            let link = CADisplayLink(target: self, selector: #selector(autoscroll))
            link.add(to: .main, forMode: .common)
            d.link = link
        case .changed:
            if let d = drag { position(d) }
        case .ended, .cancelled, .failed:
            finishDrag(animated: true)
        default:
            break
        }
    }

    /// The row follows the finger; passing the middle of a neighbour reports a move.
    private func position(_ d: Drag) {
        guard let body = d.row.superview else { return }
        let home = untransformedFrame(d.row)
        // Half a row of travel past either end, so the row can pass the middle of the last one.
        let y = min(max(-home.height / 2, d.home + d.gesture.location(in: body).y - d.start), body.bounds.height - home.height / 2)
        d.row.transform = CGAffineTransform(translationX: 0, y: y - home.minY).scaledBy(x: 1.02, y: 1.02)
        if d.pendingAt > 0, CACurrentMediaTime() - d.pendingAt < 0.5 { return }
        let center = y + home.height / 2
        let siblings = body.subviews.filter { $0.tag > 0 && $0 !== d.row && $0.isUserInteractionEnabled && rows[$0.tag] != nil }
        let above = siblings.filter { $0.frame.minY < home.minY }.max { $0.frame.minY < $1.frame.minY }
        let below = siblings.filter { $0.frame.minY > home.minY }.min { $0.frame.minY < $1.frame.minY }
        if let below, center > below.frame.midY { report(d, by: 1) } else if let above, center < above.frame.midY { report(d, by: -1) }
    }

    private func report(_ d: Drag, by: Int) {
        d.pendingAt = CACurrentMediaTime()
        UISelectionFeedbackGenerator().selectionChanged()
        dispatch?(d.id, "move", ["by": by])
    }

    /// Near the top or bottom edge of the scroll view, scroll it so the row can travel further.
    @objc private func autoscroll() {
        guard let d = drag, let scroll = d.scroll else { return }
        let y = d.gesture.location(in: scroll).y - scroll.contentOffset.y
        let edge: CGFloat = 60
        let speed = y < edge ? -(edge - y) / 4 : y > scroll.bounds.height - edge ? (y - (scroll.bounds.height - edge)) / 4 : 0
        guard speed != 0 else { return }
        let maxY = max(0, scroll.contentSize.height - scroll.bounds.height)
        let next = min(max(0, scroll.contentOffset.y + speed), maxY)
        guard next != scroll.contentOffset.y else { return }
        scroll.contentOffset.y = next
        position(d)
    }

    private func finishDrag(animated: Bool) {
        guard let d = drag else { return }
        drag = nil
        endedAt = CACurrentMediaTime()
        d.link?.invalidate()
        let settle = {
            d.row.transform = .identity
            d.row.layer.shadowOpacity = 0
        }
        guard animated else {
            settle()
            d.row.layer.zPosition = 0
            return
        }
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: settle) { _ in
            d.row.layer.zPosition = 0
        }
    }

    /// The row's frame without its swipe or drag transform (`frame` is undefined while transformed).
    private func untransformedFrame(_ view: UIView) -> CGRect {
        let size = view.bounds.size
        return CGRect(x: view.center.x - size.width / 2, y: view.center.y - size.height / 2, width: size.width, height: size.height)
    }
}
