import UIKit

/// One place that turns the runtime's text metrics into UIKit attributes, so
/// measurement and rendering always agree. Thread-safe: the runtime measures on its JS queue.
nonisolated enum TextStyle {
    static func font(size: Double, weight: Double) -> UIFont {
        UIFont.systemFont(ofSize: size, weight: fontWeight(weight))
    }

    static func attributes(
        size: Double, weight: Double, lineHeight: Double,
        color: UIColor = .black, align: NSTextAlignment = .natural
    ) -> [NSAttributedString.Key: Any] {
        let font = font(size: size, weight: weight)
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

    static func measure(_ text: String, size: Double, weight: Double, lineHeight: Double, maxWidth: Double) -> CGSize {
        let string = NSAttributedString(string: text, attributes: attributes(size: size, weight: weight, lineHeight: lineHeight))
        let rect = string.boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        return CGSize(width: ceil(rect.width), height: ceil(rect.height))
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
    convenience init?(hex: String) {
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
