import AVFoundation
import UIKit

/// A video node: an AVPlayerLayer filling the frame (`contain` or `cover`).
final class JigVideoView: UIView {
    var player: AVPlayer? {
        get { (layer as? AVPlayerLayer)?.player }
        set { (layer as? AVPlayerLayer)?.player = newValue }
    }
    var gravity = AVLayerVideoGravity.resizeAspect {
        didSet { (layer as? AVPlayerLayer)?.videoGravity = gravity }
    }

    override static var layerClass: AnyClass { AVPlayerLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        (layer as? AVPlayerLayer)?.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) { fatalError() }
}

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
    /// A tap on a link sends `link` with its URL instead of `tap`; the runtime decides.
    var onLink: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleLinkTap(_:))))
    }

    required init?(coder: NSCoder) { fatalError() }

    // Only a tap on a link is the label's: any other tap goes to the row or button around it.
    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard gesture.view === self, gesture is UITapGestureRecognizer else { return super.gestureRecognizerShouldBegin(gesture) }
        return onLink != nil && url(at: gesture.location(in: self)) != nil
    }

    @objc private func handleLinkTap(_ gesture: UITapGestureRecognizer) {
        if let url = url(at: gesture.location(in: self)) { onLink?(url) }
    }

    /// The linked URL at a point in the view, if the tap hit a link's characters.
    func url(at point: CGPoint) -> String? {
        let box = bounds.inset(by: insets)
        guard box.contains(point), text.length > 0 else { return nil }
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: box.size)
        container.lineFragmentPadding = 0
        container.lineBreakMode = .byWordWrapping
        container.maximumNumberOfLines = 0
        layout.addTextContainer(container)
        let loc = CGPoint(x: point.x - box.minX, y: point.y - box.minY)
        let idx = layout.characterIndex(for: loc, in: container, fractionOfDistanceBetweenInsertionPoints: nil)
        guard idx < text.length else { return nil }
        // The index snaps to the nearest glyph; confirm the tap is on its line's text.
        var range = NSRange()
        guard layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: idx), effectiveRange: &range).contains(loc) else { return nil }
        return text.attribute(.link, at: idx, effectiveRange: nil) as? String
    }

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

/// A multiline text field: a UITextView that wraps and grows to its frame (the
/// runtime sizes it to fit up to 6 lines, then it scrolls inside). Return submits
/// instead of inserting a newline. (Named for the field, since JigTextView is the
/// text label above.)
final class JigMultilineTextField: UITextView {
    var insets: UIEdgeInsets = .zero {
        didSet {
            textContainerInset = insets
            setNeedsLayout()
        }
    }
    /// Shown inside the insets while the text is empty.
    let placeholderLabel = UILabel()

    convenience init() {
        self.init(frame: .zero, textContainer: nil)
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        self.textContainer.lineFragmentPadding = 0
        textContainerInset = .zero
        isScrollEnabled = true
        backgroundColor = .clear
        font = .systemFont(ofSize: 17)
        returnKeyType = .done
        placeholderLabel.numberOfLines = 0
        placeholderLabel.backgroundColor = .clear
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.isUserInteractionEnabled = false
        addSubview(placeholderLabel)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var text: String! {
        didSet { refreshPlaceholder() }
    }

    func refreshPlaceholder() {
        placeholderLabel.isHidden = !(text?.isEmpty ?? true)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholderLabel.frame = bounds.inset(by: insets)
    }
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
/// subviews (indicators) would otherwise shift child indexes. A canvas (the builder's
/// whiteboard) also zooms; a paging hscroll reports the page it settles on.
final class JigScrollView: UIScrollView, UIScrollViewDelegate {
    let content = UIView()
    /// Set when a long list inside needs the scroll offset.
    var onScroll: ((CGFloat) -> Void)?
    /// Set on a paging hscroll: called with the page index after a swipe settles.
    var onPage: ((Int) -> Void)?
    var zoomable = false {
        didSet {
            minimumZoomScale = zoomable ? 0.3 : 1
            maximumZoomScale = zoomable ? 2.5 : 1
        }
    }
    private var size = CGSize.zero

    override var contentOffset: CGPoint {
        didSet { if contentOffset.y != oldValue.y { onScroll?(contentOffset.y) } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(content)
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        contentInsetAdjustmentBehavior = .never
        delegate = self
    }

    required init?(coder: NSCoder) { fatalError() }

    func setContentSize(_ size: CGSize) {
        self.size = size
        // Zoomed, the content view is scaled: keep its layout size and scale the scroll size.
        content.bounds = CGRect(origin: .zero, size: size)
        content.center = CGPoint(x: size.width * zoomScale / 2, y: size.height * zoomScale / 2)
        contentSize = CGSize(width: size.width * zoomScale, height: size.height * zoomScale)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { zoomable ? content : nil }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { reportPage() }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { reportPage() }
    }

    private func reportPage() {
        guard isPagingEnabled, bounds.width > 0 else { return }
        onPage?(Int((contentOffset.x / bounds.width).rounded()))
    }

    func show(page: Int, animated: Bool) {
        let x = CGFloat(page) * bounds.width
        if abs(contentOffset.x - x) > 1 { setContentOffset(CGPoint(x: x, y: 0), animated: animated) }
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
