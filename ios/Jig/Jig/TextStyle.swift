import UIKit

/// One place that turns the runtime's text metrics into UIKit attributes, so
/// measurement and rendering always agree. Thread-safe: the runtime measures on its JS queue.
nonisolated enum TextStyle {
    /// One styled run: UTF-16 offsets into the text, like the runtime sends.
    struct Run: Sendable {
        var start: Int
        var end: Int
        var bold: Bool
        var italic: Bool
    }

    /// The system font, or its monospaced variant (`fontFamily: "mono"`, the builder's code view).
    static func font(size: Double, weight: Double, mono: Bool = false, italic: Bool = false) -> UIFont {
        let base = mono ? UIFont.monospacedSystemFont(ofSize: size, weight: fontWeight(weight)) : UIFont.systemFont(ofSize: size, weight: fontWeight(weight))
        guard italic, let desc = base.fontDescriptor.withSymbolicTraits(.traitItalic) else { return base }
        return UIFont(descriptor: desc, size: size)
    }

    static func attributes(
        size: Double, weight: Double, lineHeight: Double, mono: Bool = false,
        color: UIColor = .black, align: NSTextAlignment = .natural
    ) -> [NSAttributedString.Key: Any] {
        let font = font(size: size, weight: weight, mono: mono)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.alignment = align
        return [
            .font: font,
            .paragraphStyle: paragraph,
            .foregroundColor: color,
            // Fixed line heights put glyphs at the bottom of the line box; recenter them.
            .baselineOffset: (lineHeight - font.lineHeight) / 4,
        ]
    }

    /// Measures the style JSON the runtime sends (base metrics plus `spans` runs).
    static func measure(_ text: String, style: [String: Any], maxWidth: Double) -> CGSize {
        let size = (style["fontSize"] as? NSNumber)?.doubleValue ?? 17
        let weight = (style["fontWeight"] as? NSNumber)?.doubleValue ?? 400
        let lineHeight = (style["lineHeight"] as? NSNumber)?.doubleValue ?? 22
        let mono = style["fontFamily"] as? String == "mono"
        let base = attributes(size: size, weight: weight, lineHeight: lineHeight, mono: mono)
        let runs = (style["spans"] as? [[String: Any]] ?? []).compactMap { run($0) }
        guard !runs.isEmpty else {
            return measure(NSAttributedString(string: text, attributes: base), maxWidth: maxWidth)
        }
        let string = NSMutableAttributedString(string: text, attributes: base)
        let length = (text as NSString).length
        for r in runs {
            let loc = max(0, min(r.start, length))
            let len = max(0, min(r.end, length) - loc)
            guard len > 0 else { continue }
            string.addAttribute(
                .font,
                value: font(size: size, weight: r.bold ? 700 : weight, mono: mono, italic: r.italic),
                range: NSRange(location: loc, length: len)
            )
        }
        return measure(string, maxWidth: maxWidth)
    }

    /// A `text` node's spans prop: the base attributes everywhere, each run's
    /// weight, slant, color and link over its own text. Colors arrive resolved.
    static func spanned(
        _ spans: [[String: Any]],
        size: Double, weight: Double, lineHeight: Double, mono: Bool,
        color: UIColor, align: NSTextAlignment
    ) -> NSAttributedString {
        let base = attributes(size: size, weight: weight, lineHeight: lineHeight, mono: mono, color: color, align: align)
        let out = NSMutableAttributedString(string: "", attributes: base)
        for span in spans {
            guard let part = span["text"] as? String, !part.isEmpty else { continue }
            var attrs = base
            attrs[.font] = font(
                size: size,
                weight: (span["bold"] as? Bool) == true ? 700 : weight,
                mono: mono,
                italic: (span["italic"] as? Bool) == true
            )
            if let c = (span["color"] as? String).flatMap({ UIColor(hex: $0) }) { attrs[.foregroundColor] = c }
            if let link = span["link"] as? String, !link.isEmpty { attrs[.link] = link }
            out.append(NSAttributedString(string: part, attributes: attrs))
        }
        return out
    }

    private static func measure(_ string: NSAttributedString, maxWidth: Double) -> CGSize {
        let rect = string.boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        return CGSize(width: ceil(rect.width), height: ceil(rect.height))
    }

    /// A measured run; malformed ranges measure nothing.
    private static func run(_ dict: [String: Any]) -> Run? {
        guard let start = (dict["start"] as? NSNumber)?.intValue, let end = (dict["end"] as? NSNumber)?.intValue else { return nil }
        return Run(start: start, end: end, bold: (dict["bold"] as? Bool) == true, italic: (dict["italic"] as? Bool) == true)
    }

    private static func fontWeight(_ w: Double) -> UIFont.Weight {
        switch w {
        case ..<250: .thin
        case ..<350: .light
        case ..<450: .regular
        case ..<550: .medium
        case ..<650: .semibold
        case ..<750: .bold
        case ..<850: .heavy
        default: .black
        }
    }
}

extension UIColor {
    /// Parses the runtime's color strings: `#rgb`, `#rrggbb`, `#rrggbbaa`, `none`, `transparent`.
    nonisolated convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces).lowercased()
        switch s {
        case "", "none": return nil
        case "transparent": self.init(white: 0, alpha: 0); return
        case "white": self.init(white: 1, alpha: 1); return
        case "black": self.init(white: 0, alpha: 1); return
        default: break
        }
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        if s.count == 6 { s += "ff" }
        guard s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
        self.init(
            red: CGFloat((v >> 24) & 0xff) / 255,
            green: CGFloat((v >> 16) & 0xff) / 255,
            blue: CGFloat((v >> 8) & 0xff) / 255,
            alpha: CGFloat(v & 0xff) / 255
        )
    }
}
