import Foundation
import UIKit
import WidgetKit
import CryptoKit

/** Render static, positioned widget trees once in the app. The extension only reads PNGs. */
@MainActor
enum WidgetService {
    static let group = "group.dev.nitochkin.Jig"
    static func set(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        do {
            guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
                throw NSError(domain: "Jig", code: 1, userInfo: [NSLocalizedDescriptionKey: "The Jig App Group is unavailable."])
            }
            let app = args["app"] as? String ?? ""
            let catalogURL = root.appendingPathComponent("catalog.json")
            var catalog = (try? Data(contentsOf: catalogURL)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: String]] } ?? []
            let previous = catalog.filter { $0["app"] == app }
            catalog.removeAll { $0["app"] == app }
            let widgets = args["widgets"] as? [[String: Any]] ?? []
            var kept = Set<String>()
            for widget in widgets {
                let name = widget["name"] as? String ?? ""
                let size = widget["size"] as? String ?? "small"
                let id = SHA256.hash(data: Data("\(app)/\(name)".utf8)).map { String(format: "%02x", $0) }.joined()
                kept.insert(id)
                if !catalog.contains(where: { $0["id"] == id }) {
                    catalog.append(["id": id, "title": "\(args["appName"] ?? app): \(widget["title"] ?? name)", "app": app, "open": widget["open"] as? String ?? ""])
                }
                let dimensions: CGSize = size == "large" ? CGSize(width: 338, height: 354) : size == "medium" ? CGSize(width: 338, height: 158) : CGSize(width: 158, height: 158)
                var entries: [[String: Any]] = []
                for (index, entry) in (widget["entries"] as? [[String: Any]] ?? []).enumerated() {
                    var saved: [String: Any] = ["date": entry["date"] ?? 0]
                    for theme in ["light", "dark"] {
                        let filename = "\(id)-\(size)-\(index)-\(theme).png"
                        let tree = entry[theme] as? [String: Any] ?? [:]
                        let format = UIGraphicsImageRendererFormat(); format.scale = 2
                        let image = UIGraphicsImageRenderer(size: dimensions, format: format).image { ctx in
                            (theme == "dark" ? UIColor.black : .white).setFill(); ctx.fill(CGRect(origin: .zero, size: dimensions))
                            draw(tree, ctx.cgContext)
                        }
                        try image.pngData()?.write(to: root.appendingPathComponent(filename), options: .atomic)
                        saved[theme] = filename
                    }
                    entries.append(saved)
                }
                try JSONSerialization.data(withJSONObject: entries).write(to: root.appendingPathComponent("\(id)-\(size).json"), options: .atomic)
            }
            for old in previous where !kept.contains(old["id"] ?? "") {
                for file in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where file.lastPathComponent.hasPrefix((old["id"] ?? "invalid") + "-") { try? FileManager.default.removeItem(at: file) }
            }
            try JSONSerialization.data(withJSONObject: catalog).write(to: catalogURL, options: .atomic)
            WidgetCenter.shared.reloadAllTimelines()
            done(Services.result([:]))
        } catch { done(Services.error(error.localizedDescription)) }
    }
    private static func rect(_ value: Any?) -> CGRect {
        if let a = value as? [Double], a.count == 4 { return CGRect(x: a[0], y: a[1], width: a[2], height: a[3]) }
        let r = value as? [String: Double] ?? [:]
        return CGRect(x: r["x"] ?? 0, y: r["y"] ?? 0, width: r["width"] ?? r["w"] ?? 0, height: r["height"] ?? r["h"] ?? 0)
    }
    private static func color(_ value: Any?) -> UIColor? { (value as? String).flatMap(UIColor.init(hex:)) }
    private static func draw(_ node: [String: Any], _ ctx: CGContext) {
        let frame = rect(node["frame"])
        ctx.saveGState()
        ctx.setAlpha(node["opacity"] as? Double ?? 1)
        if let background = color(node["background"]) {
            background.setFill(); UIBezierPath(roundedRect: frame, cornerRadius: node["radius"] as? Double ?? 0).fill()
        }
        if let border = color(node["borderColor"]), let width = node["borderWidth"] as? Double, width > 0 {
            border.setStroke(); let path = UIBezierPath(roundedRect: frame.insetBy(dx: width / 2, dy: width / 2), cornerRadius: node["radius"] as? Double ?? 0); path.lineWidth = width; path.stroke()
        }
        switch node["kind"] as? String {
        case "text":
            let size = node["fontSize"] as? Double ?? 17
            let weight = node["fontWeight"] as? Double ?? 400
            let font = node["fontFamily"] as? String == "mono" ? UIFont.monospacedSystemFont(ofSize: size, weight: weight >= 600 ? .bold : .regular) : UIFont.systemFont(ofSize: size, weight: weight >= 600 ? .bold : .regular)
            let paragraph = NSMutableParagraphStyle()
            paragraph.minimumLineHeight = node["lineHeight"] as? Double ?? size * 1.3
            paragraph.maximumLineHeight = paragraph.minimumLineHeight
            paragraph.alignment = node["align"] as? String == "center" ? .center : node["align"] as? String == "right" ? .right : .left
            (node["text"] as? String ?? "").draw(in: frame, withAttributes: [.font: font, .foregroundColor: color(node["color"]) ?? .label, .paragraphStyle: paragraph])
        case "shape":
            let parts = (node["viewBox"] as? String ?? "0 0 24 24").split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
            if parts.count == 4, parts[2] > 0, parts[3] > 0 {
                let layer = CAShapeLayer(); layer.frame = frame
                let scale = min(frame.width / parts[2], frame.height / parts[3])
                var transform = CGAffineTransform(translationX: (frame.width - parts[2] * scale) / 2 - parts[0] * scale, y: (frame.height - parts[3] * scale) / 2 - parts[1] * scale).scaledBy(x: scale, y: scale)
                layer.path = SVGPath.parse(node["path"] as? String ?? "").copy(using: &transform)
                layer.fillColor = color(node["fill"])?.cgColor; layer.strokeColor = color(node["stroke"])?.cgColor
                layer.lineWidth = (node["strokeWidth"] as? Double ?? 1) * scale
                layer.strokeStart = node["trimStart"] as? Double ?? 0; layer.strokeEnd = node["trimEnd"] as? Double ?? 1
                ctx.saveGState(); ctx.translateBy(x: frame.minX, y: frame.minY); layer.render(in: ctx); ctx.restoreGState()
            }
        case "image":
            if let src = node["src"] as? String, src.hasPrefix("data:"), let comma = src.firstIndex(of: ","), let data = Data(base64Encoded: String(src[src.index(after: comma)...])) { UIImage(data: data)?.draw(in: frame) }
        default: break
        }
        for child in node["children"] as? [[String: Any]] ?? [] { draw(child, ctx) }
        ctx.restoreGState()
    }
}
