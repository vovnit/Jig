// Renders the demo video's stills (background, title cards, captions, phone masks and
// shadows) to PNGs with the system font, since the installed ffmpeg can't draw text.
//
// Usage: swift scripts/demo-cards.swift <jobs.json>
// jobs.json: [{"kind": ..., "out": "path.png", ...}], see the cases below.
import AppKit

let W: CGFloat = 1920, H: CGFloat = 1080
let ink = NSColor.white
let soft = NSColor(red: 0.69, green: 0.73, blue: 0.88, alpha: 1)
let accent = NSColor(red: 0.42, green: 0.48, blue: 1.0, alpha: 1)

func image(_ w: CGFloat, _ h: CGFloat, _ draw: (CGContext) -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(w), pixelsHigh: Int(h), bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    // Top-left origin, like the video.
    ctx.cgContext.translateBy(x: 0, y: h)
    ctx.cgContext.scaleBy(x: 1, y: -1)
    draw(ctx.cgContext)
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

func save(_ rep: NSBitmapImageRep, _ path: String) {
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

/// The stage: a deep navy-to-violet gradient with a soft accent glow behind the phones.
func background(_ cg: CGContext) {
    let space = CGColorSpaceCreateDeviceRGB()
    let g = CGGradient(colorsSpace: space, colors: [
        NSColor(red: 0.04, green: 0.05, blue: 0.12, alpha: 1).cgColor,
        NSColor(red: 0.10, green: 0.07, blue: 0.25, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 1])!
    cg.drawLinearGradient(g, start: CGPoint(x: 0, y: 0), end: CGPoint(x: W, y: H), options: [])
    let glow = CGGradient(colorsSpace: space, colors: [
        accent.withAlphaComponent(0.35).cgColor, accent.withAlphaComponent(0).cgColor,
    ] as CFArray, locations: [0, 1])!
    cg.drawRadialGradient(glow, startCenter: CGPoint(x: 1340, y: 560), startRadius: 0,
                          endCenter: CGPoint(x: 1340, y: 560), endRadius: 760, options: [])
    let glow2 = CGGradient(colorsSpace: space, colors: [
        NSColor(red: 0.75, green: 0.35, blue: 1, alpha: 0.18).cgColor, NSColor(red: 0.75, green: 0.35, blue: 1, alpha: 0).cgColor,
    ] as CFArray, locations: [0, 1])!
    cg.drawRadialGradient(glow2, startCenter: CGPoint(x: 260, y: 980), startRadius: 0,
                          endCenter: CGPoint(x: 260, y: 980), endRadius: 700, options: [])
}

func font(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont { NSFont.systemFont(ofSize: size, weight: weight) }

/// Draws `text` wrapped to `width` at `origin` (top-left); returns its height.
@discardableResult
func text(_ s: String, _ f: NSFont, _ color: NSColor, at origin: CGPoint, width: CGFloat, align: NSTextAlignment = .left, kern: CGFloat = 0, lineHeight: CGFloat? = nil) -> CGFloat {
    let para = NSMutableParagraphStyle()
    para.alignment = align
    if let lineHeight { para.minimumLineHeight = lineHeight; para.maximumLineHeight = lineHeight }
    let attrs: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: color, .paragraphStyle: para, .kern: kern]
    let str = NSAttributedString(string: s, attributes: attrs)
    let rect = str.boundingRect(with: CGSize(width: width, height: 2000), options: [.usesLineFragmentOrigin, .usesFontLeading])
    NSGraphicsContext.current!.cgContext.saveGState()
    // AppKit draws text in a flipped-aware way; flip back locally for this rect.
    let cg = NSGraphicsContext.current!.cgContext
    cg.translateBy(x: origin.x, y: origin.y + rect.height)
    cg.scaleBy(x: 1, y: -1)
    str.draw(with: CGRect(x: 0, y: 0, width: width, height: rect.height), options: [.usesLineFragmentOrigin, .usesFontLeading])
    cg.restoreGState()
    return ceil(rect.height)
}

/// Jig's mark: a rounded accent tile with a "J".
func logo(_ cg: CGContext, center: CGPoint, size: CGFloat) {
    let r = CGRect(x: center.x - size / 2, y: center.y - size / 2, width: size, height: size)
    let space = CGColorSpaceCreateDeviceRGB()
    let g = CGGradient(colorsSpace: space, colors: [accent.cgColor, NSColor(red: 0.72, green: 0.38, blue: 1, alpha: 1).cgColor] as CFArray, locations: [0, 1])!
    cg.saveGState()
    cg.addPath(CGPath(roundedRect: r, cornerWidth: size * 0.26, cornerHeight: size * 0.26, transform: nil))
    cg.clip()
    cg.drawLinearGradient(g, start: r.origin, end: CGPoint(x: r.maxX, y: r.maxY), options: [])
    cg.restoreGState()
    text("J", font(size * 0.62, .heavy), ink, at: CGPoint(x: r.minX, y: r.minY + size * 0.12), width: size, align: .center)
}

let jobs = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
for job in jobs {
    let out = job["out"] as! String
    switch job["kind"] as! String {
    case "background":
        save(image(W, H) { background($0) }, out)
    case "card":
        // A title card: logo, a headline, a line under it, and a small footer.
        save(image(W, H) { cg in
            background(cg)
            logo(cg, center: CGPoint(x: W / 2, y: 330), size: 150)
            text(job["title"] as! String, font(118, .bold), ink, at: CGPoint(x: 160, y: 440), width: W - 320, align: .center, kern: -1)
            text(job["subtitle"] as! String, font(46, .medium), soft, at: CGPoint(x: 160, y: 600), width: W - 320, align: .center)
            if let foot = job["footer"] as? String {
                text(foot, font(28, .regular), soft.withAlphaComponent(0.8), at: CGPoint(x: 160, y: 930), width: W - 320, align: .center, kern: 0.5)
            }
        }, out)
    case "caption":
        // The left column: a small step label, a big headline and a softer line.
        let w = CGFloat(job["width"] as? Double ?? 700), h = CGFloat(job["height"] as? Double ?? 520)
        save(image(w, h) { _ in
            var y: CGFloat = 0
            if let step = job["step"] as? String, !step.isEmpty {
                y += text(step.uppercased(), font(26, .bold), accent, at: CGPoint(x: 0, y: y), width: w, kern: 3) + 18
            }
            y += text(job["title"] as! String, font(76, .bold), ink, at: CGPoint(x: 0, y: y), width: w, kern: -0.5, lineHeight: 84) + 20
            if let sub = job["subtitle"] as? String, !sub.isEmpty {
                text(sub, font(36, .regular), soft, at: CGPoint(x: 0, y: y), width: w, lineHeight: 46)
            }
        }, out)
    case "chapter":
        // A chapter title for the left column: a large accent number, a headline, one line.
        let w = CGFloat(job["width"] as? Double ?? 700), h = CGFloat(job["height"] as? Double ?? 640)
        save(image(w, h) { cg in
            var y: CGFloat = 0
            y += text(job["step"] as! String, font(120, .heavy), accent, at: CGPoint(x: -6, y: y), width: w, kern: -2, lineHeight: 120) + 6
            cg.setFillColor(accent.withAlphaComponent(0.8).cgColor)
            cg.fill(CGRect(x: 0, y: y, width: 72, height: 6))
            y += 36
            y += text(job["title"] as! String, font(88, .bold), ink, at: CGPoint(x: 0, y: y), width: w, kern: -1, lineHeight: 96) + 28
            text(job["subtitle"] as! String, font(34, .regular), soft, at: CGPoint(x: 0, y: y), width: w * 0.92, lineHeight: 46)
        }, out)
    case "section":
        // A section's backdrop: the stage background with a headline and a line under it.
        save(image(W, H) { cg in
            background(cg)
            text(job["title"] as! String, font(64, .bold), ink, at: CGPoint(x: 155, y: 110), width: W - 310, kern: -0.5)
            text(job["subtitle"] as! String, font(32, .regular), soft, at: CGPoint(x: 155, y: 196), width: W - 310)
        }, out)
    case "tile":
        // One capability: an SF Symbol in an accent badge, a title and a line, on a glassy card.
        let w = CGFloat(job["width"] as! Double), h = CGFloat(job["height"] as! Double)
        save(image(w, h) { cg in
            let card = CGRect(x: 0, y: 0, width: w, height: h)
            cg.setFillColor(NSColor.white.withAlphaComponent(0.07).cgColor)
            cg.addPath(CGPath(roundedRect: card, cornerWidth: 28, cornerHeight: 28, transform: nil))
            cg.fillPath()
            cg.setStrokeColor(NSColor.white.withAlphaComponent(0.12).cgColor)
            cg.setLineWidth(2)
            cg.addPath(CGPath(roundedRect: card.insetBy(dx: 1, dy: 1), cornerWidth: 27, cornerHeight: 27, transform: nil))
            cg.strokePath()
            let badge = CGRect(x: 32, y: 32, width: 72, height: 72)
            let space = CGColorSpaceCreateDeviceRGB()
            let g = CGGradient(colorsSpace: space, colors: [accent.cgColor, NSColor(red: 0.72, green: 0.38, blue: 1, alpha: 1).cgColor] as CFArray, locations: [0, 1])!
            cg.saveGState()
            cg.addPath(CGPath(roundedRect: badge, cornerWidth: 20, cornerHeight: 20, transform: nil))
            cg.clip()
            cg.drawLinearGradient(g, start: badge.origin, end: CGPoint(x: badge.maxX, y: badge.maxY), options: [])
            cg.restoreGState()
            if let name = job["icon"] as? String,
               let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 34, weight: .semibold).applying(.init(paletteColors: [.white]))) {
                let s = symbol.size
                let r = CGRect(x: badge.midX - s.width / 2, y: badge.midY - s.height / 2, width: s.width, height: s.height)
                // Images draw upright in the flipped context only when flipped back locally.
                cg.saveGState()
                cg.translateBy(x: 0, y: r.minY * 2 + r.height)
                cg.scaleBy(x: 1, y: -1)
                symbol.draw(in: r)
                cg.restoreGState()
            }
            let y = 128 + text(job["title"] as! String, font(34, .bold), ink, at: CGPoint(x: 32, y: 128), width: w - 64, kern: -0.3) + 8
            text(job["text"] as! String, font(23, .regular), soft, at: CGPoint(x: 32, y: y), width: w - 64, lineHeight: 30)
        }, out)
    case "label":
        // Platform labels under the phones, on a transparent full frame.
        save(image(W, H) { _ in
            for l in job["labels"] as! [[String: Any]] {
                let x = CGFloat(l["x"] as! Double), y = CGFloat(l["y"] as! Double), width = CGFloat(l["width"] as! Double)
                text(l["text"] as! String, font(26, .semibold), soft, at: CGPoint(x: x, y: y), width: width, align: .center, kern: 1)
            }
        }, out)
    case "mask":
        // White rounded rect on black: the phone screen's alpha for alphamerge.
        let w = CGFloat(job["width"] as! Double), h = CGFloat(job["height"] as! Double), r = CGFloat(job["radius"] as! Double)
        save(image(w, h) { cg in
            cg.setFillColor(NSColor.black.cgColor)
            cg.fill(CGRect(x: 0, y: 0, width: w, height: h))
            cg.setFillColor(NSColor.white.cgColor)
            cg.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil))
            cg.fillPath()
        }, out)
    case "frame":
        // A phone's soft shadow and thin bezel, drawn on a transparent full frame.
        save(image(W, H) { cg in
            for p in job["phones"] as! [[String: Any]] {
                let rect = CGRect(x: p["x"] as! Double, y: p["y"] as! Double, width: p["width"] as! Double, height: p["height"] as! Double)
                let r = CGFloat(p["radius"] as! Double)
                let bezel = rect.insetBy(dx: -10, dy: -10)
                cg.saveGState()
                cg.setShadow(offset: CGSize(width: 0, height: 24), blur: 60, color: NSColor.black.withAlphaComponent(0.6).cgColor)
                cg.setFillColor(NSColor(red: 0.08, green: 0.08, blue: 0.11, alpha: 1).cgColor)
                cg.addPath(CGPath(roundedRect: bezel, cornerWidth: r + 10, cornerHeight: r + 10, transform: nil))
                cg.fillPath()
                cg.restoreGState()
                cg.setStrokeColor(NSColor.white.withAlphaComponent(0.14).cgColor)
                cg.setLineWidth(2)
                cg.addPath(CGPath(roundedRect: bezel.insetBy(dx: 1, dy: 1), cornerWidth: r + 9, cornerHeight: r + 9, transform: nil))
                cg.strokePath()
            }
        }, out)
    default:
        fatalError("unknown kind")
    }
}
