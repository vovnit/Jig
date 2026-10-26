import CoreGraphics
import Foundation

/// Parses SVG path data (`d`) into a CGPath. Supports every command:
/// M L H V C S Q T A Z, absolute and relative, with implicit repeats.
enum SVGPath {
    private static var cache: [String: CGPath] = [:]

    static func parse(_ d: String) -> CGPath {
        if let hit = cache[d] { return hit }
        let path = CGMutablePath()
        var s = PathScanner(Array(d.utf8))
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?
        var lastCmd: UInt8 = 0
        var cmd: UInt8 = 0

        while true {
            if let c = s.command() {
                cmd = c
            } else if s.atNumber, cmd != 0 {
                // Implicit repeat; extra moveto pairs are linetos.
                if cmd == UInt8(ascii: "M") { cmd = UInt8(ascii: "L") }
                if cmd == UInt8(ascii: "m") { cmd = UInt8(ascii: "l") }
            } else {
                break
            }
            let rel = cmd >= UInt8(ascii: "a")
            let upper = rel ? cmd - 32 : cmd
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y) }

            switch upper {
            case UInt8(ascii: "M"):
                guard let x = s.number(), let y = s.number() else { return finish(path, d) }
                cur = pt(x, y)
                start = cur
                path.move(to: cur)
            case UInt8(ascii: "L"):
                guard let x = s.number(), let y = s.number() else { return finish(path, d) }
                cur = pt(x, y)
                path.addLine(to: cur)
            case UInt8(ascii: "H"):
                guard let x = s.number() else { return finish(path, d) }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y)
                path.addLine(to: cur)
            case UInt8(ascii: "V"):
                guard let y = s.number() else { return finish(path, d) }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y)
                path.addLine(to: cur)
            case UInt8(ascii: "C"):
                guard let x1 = s.number(), let y1 = s.number(), let x2 = s.number(), let y2 = s.number(),
                      let x = s.number(), let y = s.number() else { return finish(path, d) }
                let c1 = pt(x1, y1), c2 = pt(x2, y2), end = pt(x, y)
                path.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2
                cur = end
            case UInt8(ascii: "S"):
                guard let x2 = s.number(), let y2 = s.number(), let x = s.number(), let y = s.number() else { return finish(path, d) }
                let c1 = isCubic(lastCmd) ? reflect(lastControl, around: cur) : cur
                let c2 = pt(x2, y2), end = pt(x, y)
                path.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2
                cur = end
            case UInt8(ascii: "Q"):
                guard let x1 = s.number(), let y1 = s.number(), let x = s.number(), let y = s.number() else { return finish(path, d) }
                let c = pt(x1, y1), end = pt(x, y)
                path.addQuadCurve(to: end, control: c)
                lastControl = c
                cur = end
            case UInt8(ascii: "T"):
                guard let x = s.number(), let y = s.number() else { return finish(path, d) }
                let c = isQuad(lastCmd) ? reflect(lastControl, around: cur) : cur
                let end = pt(x, y)
                path.addQuadCurve(to: end, control: c)
                lastControl = c
                cur = end
            case UInt8(ascii: "A"):
                guard let rx = s.number(), let ry = s.number(), let rot = s.number(),
                      let large = s.flag(), let sweep = s.flag(),
                      let x = s.number(), let y = s.number() else { return finish(path, d) }
                let end = pt(x, y)
                addArc(path, from: cur, to: end, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                cur = end
            case UInt8(ascii: "Z"):
                path.closeSubpath()
                cur = start
            default:
                return finish(path, d)
            }
            lastCmd = upper
        }
        return finish(path, d)
    }

    private static func finish(_ path: CGMutablePath, _ d: String) -> CGPath {
        if cache.count > 500 { cache.removeAll() }
        cache[d] = path
        return path
    }

    private static func isCubic(_ c: UInt8) -> Bool { c == UInt8(ascii: "C") || c == UInt8(ascii: "S") }
    private static func isQuad(_ c: UInt8) -> Bool { c == UInt8(ascii: "Q") || c == UInt8(ascii: "T") }

    private static func reflect(_ p: CGPoint?, around c: CGPoint) -> CGPoint {
        guard let p else { return c }
        return CGPoint(x: 2 * c.x - p.x, y: 2 * c.y - p.y)
    }

    /// Endpoint arc → center parameterization (SVG spec F.6.5), drawn as cubic segments of ≤ 90°.
    private static func addArc(
        _ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint,
        rx rxIn: CGFloat, ry ryIn: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool
    ) {
        if p0 == p1 { return }
        var rx = abs(rxIn), ry = abs(ryIn)
        if rx == 0 || ry == 0 {
            path.addLine(to: p1)
            return
        }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy

        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            rx *= sqrt(lambda)
            ry *= sqrt(lambda)
        }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var coef = sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cxp = coef * (rx * y1p / ry)
        let cyp = coef * -(ry * x1p / rx)
        let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }

        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let k = 4.0 / 3.0 * tan(step / 4)
        func point(_ t: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cos(t) * cosPhi - ry * sin(t) * sinPhi,
                    y: cy + rx * cos(t) * sinPhi + ry * sin(t) * cosPhi)
        }
        func derivative(_ t: CGFloat) -> CGPoint {
            CGPoint(x: -rx * sin(t) * cosPhi - ry * cos(t) * sinPhi,
                    y: -rx * sin(t) * sinPhi + ry * cos(t) * cosPhi)
        }
        var t = theta1
        for i in 0..<segments {
            let t2 = t + step
            let a = point(t), b = i == segments - 1 ? p1 : point(t2)
            let da = derivative(t), db = derivative(t2)
            path.addCurve(
                to: b,
                control1: CGPoint(x: a.x + k * da.x, y: a.y + k * da.y),
                control2: CGPoint(x: b.x - k * db.x, y: b.y - k * db.y)
            )
            t = t2
        }
    }
}

private struct PathScanner {
    let c: [UInt8]
    var i = 0
    init(_ c: [UInt8]) { self.c = c }

    private func isSep(_ b: UInt8) -> Bool { b == 32 || b == 9 || b == 10 || b == 13 || b == 44 }
    private func isDigit(_ b: UInt8) -> Bool { b >= 48 && b <= 57 }

    mutating func skip() { while i < c.count, isSep(c[i]) { i += 1 } }

    var atNumber: Bool {
        mutating get {
            skip()
            guard i < c.count else { return false }
            let b = c[i]
            return isDigit(b) || b == UInt8(ascii: "-") || b == UInt8(ascii: "+") || b == UInt8(ascii: ".")
        }
    }

    mutating func command() -> UInt8? {
        skip()
        guard i < c.count else { return nil }
        let b = c[i] | 0x20
        // Letters other than the exponent marker `e`.
        if b >= UInt8(ascii: "a"), b <= UInt8(ascii: "z"), b != UInt8(ascii: "e") {
            i += 1
            return c[i - 1]
        }
        return nil
    }

    mutating func flag() -> Bool? {
        skip()
        guard i < c.count, c[i] == UInt8(ascii: "0") || c[i] == UInt8(ascii: "1") else { return nil }
        i += 1
        return c[i - 1] == UInt8(ascii: "1")
    }

    mutating func number() -> CGFloat? {
        skip()
        let begin = i
        if i < c.count, c[i] == UInt8(ascii: "-") || c[i] == UInt8(ascii: "+") { i += 1 }
        var seenDot = false
        while i < c.count {
            if isDigit(c[i]) { i += 1 }
            else if c[i] == UInt8(ascii: "."), !seenDot { seenDot = true; i += 1 }
            else { break }
        }
        if i < c.count, c[i] == UInt8(ascii: "e") || c[i] == UInt8(ascii: "E") {
            i += 1
            if i < c.count, c[i] == UInt8(ascii: "-") || c[i] == UInt8(ascii: "+") { i += 1 }
            while i < c.count, isDigit(c[i]) { i += 1 }
        }
        guard i > begin, let v = Double(String(decoding: c[begin..<i], as: UTF8.self)) else {
            i = begin
            return nil
        }
        return CGFloat(v)
    }
}
