import JavaScriptCore
import QuartzCore
import UIKit

/// Runs the shared runtime (`jig-core.js`) in JavaScriptCore and bridges it to the
/// UIKit renderer.
///
/// Threading: JS runs on its own serial queue, UIKit on the main thread. Ops cross
/// to main as one JSON string per frame; events and viewport changes cross to JS
/// asynchronously. Text measurement runs on the JS queue (TextKit measurement is
/// thread-safe), so a layout never waits on the main thread.
nonisolated final class JigRuntime: @unchecked Sendable {
    struct Theme: Sendable {
        var colors: [String: String]
        var isDark: Bool
    }

    /// Called on main after a load or color scheme change.
    @MainActor var onTheme: ((Theme) -> Void)?

    // JS queue only.
    private let js = DispatchQueue(label: "dev.nitochkin.jig.js", qos: .userInteractive)
    private var context: JSContext!

    // Main thread only.
    @MainActor private var displayLink: CADisplayLink?

    @MainActor
    init(renderer: UIKitRenderer) {
        let toggleSize = UISwitch().intrinsicContentSize
        js.async { self.setUp(renderer: renderer, toggleSize: toggleSize) }
        renderer.dispatch = { [weak self] id, name, payload in self?.dispatch(id: id, name: name, payload: payload) }
    }

    // MARK: - API (call from main)

    func load(specJSON: String) {
        js.async {
            self.call("__jigLoad", specJSON)
            self.publishTheme()
        }
    }

    func setColorScheme(dark: Bool) {
        js.async {
            self.call("__jigSetColorScheme", dark ? "dark" : "light")
            self.publishTheme()
        }
    }

    func setViewport(size: CGSize, insets: UIEdgeInsets) {
        let (w, h) = (Double(size.width), Double(size.height))
        let (t, r, b, l) = (Double(insets.top), Double(insets.right), Double(insets.bottom), Double(insets.left))
        js.async { self.call("__jigSetViewport", w, h, t, r, b, l) }
    }

    func dispatch(id: Int, name: String, payload: [String: Any] = [:]) {
        let json = (try? JSONSerialization.data(withJSONObject: payload)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        js.async { self.call("__jigDispatch", id, name, json) }
    }

    /// Pops one screen (the back swipe). Does nothing on the first screen.
    func goBack() {
        js.async { self.call("__jigBack") }
    }

    // MARK: - Setup (JS queue)

    private func setUp(renderer: UIKitRenderer, toggleSize: CGSize) {
        guard let context = JSContext() else { fatalError("JavaScriptCore is unavailable") }
        self.context = context
        context.name = "Jig runtime"
        context.exceptionHandler = { _, exception in
            NSLog("[jig] JS exception: %@", exception?.toString() ?? "unknown")
        }
        installNative(renderer: renderer, toggleSize: toggleSize)
        guard let url = Bundle.main.url(forResource: "jig-core", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8)
        else {
            fatalError("jig-core.js is missing from the app bundle. Run `npm run build:native` in the repo root.")
        }
        context.evaluateScript(source, withSourceURL: url)
        // Shared with the Android host: adapts the runtime's Host interface to `__native`.
        guard let hostURL = Bundle.main.url(forResource: "jig-host", withExtension: "js"),
              let hostSource = try? String(contentsOf: hostURL, encoding: .utf8)
        else {
            fatalError("jig-host.js is missing from the app bundle. Run `npm run build:native` in the repo root.")
        }
        context.evaluateScript(hostSource, withSourceURL: hostURL)
    }

    private func call(_ function: String, _ args: Any...) {
        context.objectForKeyedSubscript(function).call(withArguments: args)
    }

    private func publishTheme() {
        guard let json = context.objectForKeyedSubscript("__jigTheme").call(withArguments: [])?.toString(),
              let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        let theme = Theme(colors: obj["colors"] as? [String: String] ?? [:], isDark: obj["dark"] as? Bool ?? false)
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.onTheme?(theme) }
        }
    }

    private func installNative(renderer: UIKitRenderer, toggleSize: CGSize) {
        let native = JSValue(newObjectIn: context)!

        let apply: @convention(block) (String, Int) -> Void = { json, navDepth in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { renderer.apply(json: json, navDepth: navDepth) }
            }
        }
        let measure: @convention(block) (String, Double, Double, Double, Double) -> [Double] = { text, size, weight, lineHeight, maxWidth in
            let s = TextStyle.measure(text, size: size, weight: weight, lineHeight: lineHeight, maxWidth: maxWidth)
            return [Double(s.width), Double(s.height)]
        }
        let measureControl: @convention(block) (String) -> [Double] = { type in
            type == "toggle" ? [Double(toggleSize.width), Double(toggleSize.height)] : [0, 0]
        }
        let requestFrame: @convention(block) () -> Void = { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.scheduleFrame() }
            }
        }
        let defaults = UserDefaults.standard
        let storageGet: @convention(block) (String) -> JSValue = { key in
            guard let value = defaults.string(forKey: key) else { return JSValue(nullIn: JSContext.current()) }
            return JSValue(object: value, in: JSContext.current())
        }
        let storageSet: @convention(block) (String, String) -> Void = { key, value in defaults.set(value, forKey: key) }
        let now: @convention(block) () -> Double = { CACurrentMediaTime() * 1000 }
        let log: @convention(block) (String, String) -> Void = { level, message in NSLog("[jig] %@: %@", level, message) }

        native.setObject(apply, forKeyedSubscript: "apply" as NSString)
        native.setObject(measure, forKeyedSubscript: "measure" as NSString)
        native.setObject(measureControl, forKeyedSubscript: "measureControl" as NSString)
        native.setObject(requestFrame, forKeyedSubscript: "requestFrame" as NSString)
        native.setObject(storageGet, forKeyedSubscript: "storageGet" as NSString)
        native.setObject(storageSet, forKeyedSubscript: "storageSet" as NSString)
        native.setObject(now, forKeyedSubscript: "now" as NSString)
        native.setObject(log, forKeyedSubscript: "log" as NSString)
        context.setObject(native, forKeyedSubscript: "__native" as NSString)
    }

    // MARK: - Frames

    @MainActor
    private func scheduleFrame() {
        if displayLink == nil {
            let link = CADisplayLink(target: DisplayLinkTarget(self), selector: #selector(DisplayLinkTarget.tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
        displayLink?.isPaused = false
    }

    @MainActor
    fileprivate func tick() {
        displayLink?.isPaused = true
        js.async { self.call("__jigFrame") }
    }
}

/// Breaks the retain cycle between CADisplayLink and the runtime.
private final class DisplayLinkTarget: NSObject {
    weak var runtime: JigRuntime?
    init(_ runtime: JigRuntime) { self.runtime = runtime }
    @objc func tick() { runtime?.tick() }
}
