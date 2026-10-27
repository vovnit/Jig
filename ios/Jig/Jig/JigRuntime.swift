import JavaScriptCore
import QuartzCore
import UIKit

/// Runs the shared runtime (`jig-core.js`) in JavaScriptCore and bridges it to the
/// UIKit renderer.
///
/// Threading: JS runs on its own serial queue, UIKit on the main thread. Ops cross
/// to main as one JSON string per frame; events and viewport changes cross to JS
/// asynchronously. Text measurement runs on the JS queue (TextKit measurement is
/// thread-safe), so a layout never waits on the main thread. SQLite also runs on the
/// JS queue: the runtime saves at the end of a frame, after the ops are sent.
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

    /// Starts the shell; `seedsJSON` is an array of bundled app specs for its list.
    func boot(shellJSON: String, seedsJSON: String) {
        js.async {
            self.call("__jigBoot", shellJSON, seedsJSON)
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

        let apply: @convention(block) (String) -> Void = { json in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { renderer.apply(json: json) }
            }
        }
        let measure: @convention(block) (String, Double, Double, Double, Double, String) -> [Double] = { text, size, weight, lineHeight, maxWidth, family in
            let s = TextStyle.measure(text, size: size, weight: weight, lineHeight: lineHeight, maxWidth: maxWidth, mono: family == "mono")
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
        let database = SQLiteDatabase.standard()
        let sqlQuery: @convention(block) (String, String) -> String = { sql, params in database.query(sql, paramsJSON: params) }
        let sqlExec: @convention(block) (String) -> String = { statements in database.exec(statements) }
        let secretGet: @convention(block) (String, String) -> String? = { app, key in SecretStore.get(app: app, key: key) }
        let secretSet: @convention(block) (String, String, String) -> String? = { app, key, value in SecretStore.set(app: app, key: key, value: value) }
        let secretDelete: @convention(block) (String, String) -> String? = { app, key in SecretStore.delete(app: app, key: key) }
        let secretClear: @convention(block) (String) -> String? = { app in SecretStore.clear(app: app) }
        let call: @convention(block) (String, String, Int) -> Void = { [weak self] service, args, id in
            guard let runtime = self else { return }
            let resolve: @Sendable (String) -> Void = { json in runtime.js.async { runtime.call("__jigResolve", id, json) } }
            if service == "screenshot" {
                // A PNG of a node's view, drawn by the renderer on main.
                let node = ((try? JSONSerialization.jsonObject(with: Data(args.utf8))) as? [String: Any])?["id"] as? Int ?? 0
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        resolve(renderer.snapshot(id: node).map { Services.result(["data": $0.base64EncodedString()]) } ?? Services.error("No view to take a picture of"))
                    }
                }
                return
            }
            Services.handle(service, argsJSON: args, done: resolve)
        }
        let now: @convention(block) () -> Double = { CACurrentMediaTime() * 1000 }
        let log: @convention(block) (String, String) -> Void = { level, message in NSLog("[jig] %@: %@", level, message) }

        native.setObject(apply, forKeyedSubscript: "apply" as NSString)
        native.setObject(measure, forKeyedSubscript: "measure" as NSString)
        native.setObject(measureControl, forKeyedSubscript: "measureControl" as NSString)
        native.setObject(requestFrame, forKeyedSubscript: "requestFrame" as NSString)
        native.setObject(sqlQuery, forKeyedSubscript: "sqlQuery" as NSString)
        native.setObject(sqlExec, forKeyedSubscript: "sqlExec" as NSString)
        native.setObject(secretGet, forKeyedSubscript: "secretGet" as NSString)
        native.setObject(secretSet, forKeyedSubscript: "secretSet" as NSString)
        native.setObject(secretDelete, forKeyedSubscript: "secretDelete" as NSString)
        native.setObject(secretClear, forKeyedSubscript: "secretClear" as NSString)
        native.setObject(call, forKeyedSubscript: "call" as NSString)
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
