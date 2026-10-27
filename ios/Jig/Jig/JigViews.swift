import UIKit

/// Text drawn with the same NSStringDrawing call the runtime measures with
/// (`TextStyle.measure`), so wrapping always matches the measured height.
/// UILabel lays out with a different engine and can drop a line.
final class JigTextView: UIView {
    var text = NSAttributedString() {
        didSet {
            accessibilityLabel = text.string
            setNeedsDisplay()
        }
    }
    var insets: UIEdgeInsets = .zero { didSet { setNeedsDisplay() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityTraits = .staticText
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        text.draw(with: bounds.inset(by: insets), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    }
}

final class JigTextField: UITextField {
    var insets: UIEdgeInsets = .zero { didSet { setNeedsLayout() } }

    override func textRect(forBounds bounds: CGRect) -> CGRect { bounds.inset(by: insets) }
    override func editingRect(forBounds bounds: CGRect) -> CGRect { bounds.inset(by: insets) }
    override func placeholderRect(forBounds bounds: CGRect) -> CGRect { bounds.inset(by: insets) }
}

final class JigButton: UIButton {
    override var isHighlighted: Bool {
        didSet {
            UIView.animate(withDuration: 0.12) {
                self.alpha = self.isHighlighted ? 0.75 : 1
                self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.98, y: 0.98) : .identity
            }
        }
    }
}

/// Scroll views keep runtime children in a content view: UIScrollView's own
/// subviews (indicators) would otherwise shift child indexes.
final class JigScrollView: UIScrollView {
    let content = UIView()
    /// Set when a long list inside needs the scroll offset.
    var onScroll: ((CGFloat) -> Void)?

    override var contentOffset: CGPoint {
        didSet { if contentOffset.y != oldValue.y { onScroll?(contentOffset.y) } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(content)
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        contentInsetAdjustmentBehavior = .never
    }

    required init?(coder: NSCoder) { fatalError() }

    func setContentSize(_ size: CGSize) {
        content.frame = CGRect(origin: .zero, size: size)
        contentSize = size
    }
}

/// A shape node: SVG path data in a viewBox, scaled to fit the frame (xMidYMid meet).
final class JigShapeView: UIView {
    override static var layerClass: AnyClass { CAShapeLayer.self }
    private var shape: CAShapeLayer { layer as! CAShapeLayer }

    var pathData = "" { didSet { if pathData != oldValue { setNeedsLayout() } } }
    var viewBox = CGRect(x: 0, y: 0, width: 24, height: 24) { didSet { setNeedsLayout() } }
    var strokeWidth: CGFloat = 1 { didSet { setNeedsLayout() } }

    typealias Animation = (duration: TimeInterval, timing: CAMediaTimingFunction)

    func setColors(fill: UIColor?, stroke: UIColor?, animation: Animation?) {
        set("fillColor", fill?.cgColor, animation) { shape.fillColor = fill?.cgColor }
        set("strokeColor", stroke?.cgColor, animation) { shape.strokeColor = stroke?.cgColor }
    }

    /// Stroke trimming (0...1): how the ring shows its value, and animates it.
    func setTrim(start: CGFloat, end: CGFloat, animation: Animation?) {
        if shape.strokeStart != start { set("strokeStart", start, animation) { shape.strokeStart = start } }
        if shape.strokeEnd != end { set("strokeEnd", end, animation) { shape.strokeEnd = end } }
    }

    /// A view's backing layer doesn't animate implicitly, so animate explicitly from what's on screen.
    private func set(_ key: String, _ value: Any?, _ animation: Animation?, apply: () -> Void) {
        if let animation {
            let a = CABasicAnimation(keyPath: key)
            a.fromValue = (shape.presentation() ?? shape).value(forKey: key)
            a.toValue = value
            a.duration = animation.duration
            a.timingFunction = animation.timing
            shape.add(a, forKey: key)
        }
        apply()
    }
    var lineCap: CAShapeLayerLineCap = .butt { didSet { shape.lineCap = lineCap } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        shape.fillColor = UIColor.black.cgColor
        shape.strokeColor = nil
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard viewBox.width > 0, viewBox.height > 0, !pathData.isEmpty else {
            shape.path = nil
            return
        }
        let scale = min(bounds.width / viewBox.width, bounds.height / viewBox.height)
        let dx = (bounds.width - viewBox.width * scale) / 2 - viewBox.minX * scale
        let dy = (bounds.height - viewBox.height * scale) / 2 - viewBox.minY * scale
        var t = CGAffineTransform(translationX: dx, y: dy).scaledBy(x: scale, y: scale)
        shape.path = SVGPath.parse(pathData).copy(using: &t)
        shape.lineWidth = strokeWidth * scale
    }
}
