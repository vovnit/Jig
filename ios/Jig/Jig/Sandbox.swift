import Foundation
import WebKit

/// Custom-code sandboxes (docs/custom-code.md): one hidden WKWebView per app id, in its
/// own WebContent process, created on first use and dropped by `script.close` or after
/// 2 minutes unused. The page carries a CSP `connect-src` with exactly the allowed
/// hosts (else `'none'`), plus a content rule list blocking other loads, so code can
/// only `fetch` what the user granted; scripts arrive as source and are kept in a
/// page-global map by script name. A call that outlives its `timeoutMs` answers
/// "Timed out" and tears the web view down, so the next call starts clean.
@MainActor
final class Sandboxes: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let shared = Sandboxes()

    /// Results over this are refused ("Result too large").
    private static let maxResultBytes = 2 * 1024 * 1024
    /// Idle sandboxes are dropped after this long.
    private static let idleNanoseconds: UInt64 = 120 * 1_000_000_000

    private var boxes: [String: Box] = [:]
    private var rules: WKContentRuleList?
    private var compilingRules = false
    private var ruleWaiters: [CheckedContinuation<Void, Never>] = []

    private override init() { super.init() }

    // MARK: - Services

    func run(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let app = args["app"] as? String, !app.isEmpty,
              let script = args["script"] as? String, !script.isEmpty,
              let fn = args["fn"] as? String, !fn.isEmpty
        else { return done(Services.error("A run needs an app, a script and a function")) }
        invoke(app: app, script: script, fn: fn, input: args["args"], code: args["code"] as? String ?? "",
               hash: args["hash"] as? String ?? "", hosts: Self.hosts(from: args),
               timeoutMs: (args["timeoutMs"] as? NSNumber)?.doubleValue ?? 5000, answerKey: "value", done: done)
    }

    func render(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let app = args["app"] as? String, !app.isEmpty,
              let script = args["script"] as? String, !script.isEmpty,
              let element = args["element"] as? String, !element.isEmpty
        else { return done(Services.error("A render needs an app, a script and an element")) }
        invoke(app: app, script: script, fn: element, input: args["props"], code: args["code"] as? String ?? "",
               hash: args["hash"] as? String ?? "", hosts: Self.hosts(from: args),
               timeoutMs: (args["timeoutMs"] as? NSNumber)?.doubleValue ?? 5000, answerKey: "tree", done: done)
    }

    func close(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        if let app = args["app"] as? String { drop(app: app) }
        done(Services.result([:]))
    }

    // MARK: - Calls

    private func invoke(app: String, script: String, fn: String, input: Any?, code: String, hash: String, hosts: [String], timeoutMs: Double, answerKey: String, done: @escaping @Sendable (String) -> Void) {
        // Clamped to 1 ms..60 s so a huge timeout can't pin a web view forever.
        let clampedMs = min(max(timeoutMs, 1), 60_000)
        let gate = AnswerGate()
        // `input` is JSON-plist values confined to these MainActor tasks.
        let boxedInput = AnyBox(input)
        Task { @MainActor in
            // The page must not load until the content rule list has compiled;
            // calls that arrive meanwhile queue here.
            await self.waitForRules()
            let box = self.ensureSandbox(app: app, hosts: hosts)
            let boxID = ObjectIdentifier(box)
            let gen = box.pageGen
            // The time limit: a late call answers once, then its web view goes away and
            // the next call rebuilds it (reloading the scripts).
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(clampedMs * 1_000_000))
                self.settle(app: app, boxID: boxID, gen: gen, gate: gate, json: Services.error("Timed out"), dropAfter: true, done: done)
            }
            Task { @MainActor in
                let result = await self.call(app: app, boxID: boxID, gen: gen, script: script, fn: fn, input: boxedInput.value, code: code, hash: hash, answerKey: answerKey)
                self.settle(app: app, boxID: boxID, gen: gen, gate: gate, json: result, dropAfter: false, done: done)
            }
        }
    }

    /// The single check-and-set for a call: `done` runs exactly once, timeout or answer.
    private func settle(app: String, boxID: ObjectIdentifier, gen: Int, gate: AnswerGate, json: String, dropAfter: Bool, done: @escaping @Sendable (String) -> Void) {
        guard !gate.claimed else { return }
        gate.claimed = true
        done(json)
        // Only the winner drops, and only its own box: a stale timeout must not
        // tear down a fresh replacement sandbox.
        if dropAfter, let current = boxes[app], ObjectIdentifier(current) == boxID, current.pageGen == gen {
            drop(app: app)
        }
    }

    private func call(app: String, boxID: ObjectIdentifier, gen: Int, script: String, fn: String, input: Any?, code: String, hash: String, answerKey: String) async -> String {
        guard let box = boxes[app], ObjectIdentifier(box) == boxID, box.pageGen == gen, box.view != nil else { return Services.error("Sandbox closed") }
        if let loadError = await waitReady(box) { return Services.error(loadError) }
        guard let box = boxes[app], ObjectIdentifier(box) == boxID, box.pageGen == gen, let view = box.view, box.ready else { return Services.error("Sandbox closed") }
        // A script loads once per hash; a new hash replaces the old exports.
        if box.loaded[script] != hash {
            do {
                _ = try await view.evaluateJavaScript(Self.loadSource(script: script, code: code))
            } catch {
                return Services.error(Self.jsMessage(error))
            }
            guard let current = boxes[app], ObjectIdentifier(current) == boxID, current.pageGen == gen, current.view === view else { return Services.error("Sandbox closed") }
            box.loaded[script] = hash
        }
        scheduleEvict(app: app)
        do {
            // `callAsyncJavaScript` awaits a returned Promise; the envelope carries the
            // JSON result or the exception's message, so the host never has to decode
            // WebKit's error for a script failure. `.page` shares the JS globals with
            // the `evaluateJavaScript`-loaded scripts; a named isolated world would not
            // see `window.__jigScripts`.
            let raw = try await view.callAsyncJavaScript(Self.callBody, arguments: ["scriptName": script, "fnName": fn, "input": input ?? NSNull()], in: nil, in: .page) as? String ?? ""
            return Self.finish(raw: raw, answerKey: answerKey)
        } catch {
            if let current = boxes[app], ObjectIdentifier(current) == boxID, current.pageGen == gen, current.view != nil { return Services.error(Self.jsMessage(error)) }
            return Services.error("Sandbox closed")
        }
    }

    /// The envelope's `{value}`/`{tree}`, parsed back from its JSON.
    private static func finish(raw: String, answerKey: String) -> String {
        guard let env = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] else {
            return Services.error("Bad script result")
        }
        if env["ok"] as? Bool == true {
            let json = env["json"] as? String ?? "null"
            if json.utf8.count > maxResultBytes { return Services.error("Result too large") }
            guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: .allowFragments) else {
                return Services.error("Bad script result")
            }
            return Services.result([answerKey: value])
        }
        return Services.error((env["message"] as? String) ?? (env["error"] as? String) ?? "Script failed")
    }

    private static func jsMessage(_ error: Error) -> String {
        if let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String, !message.isEmpty {
            return message
        }
        return (error as NSError).localizedDescription
    }

    // MARK: - Sandboxes

    /// The sandbox for `app`, rebuilt when the allowed hosts changed (so the page's
    /// CSP matches what the user granted); scripts reload on the next call. Callers
    /// wait for the content rule list first (see `invoke`), so the page never loads
    /// unprotected.
    private func ensureSandbox(app: String, hosts: [String]) -> Box {
        if let box = boxes[app], box.hosts == hosts, box.view != nil {
            scheduleEvict(app: app)
            return box
        }
        drop(app: app)
        let box = Box(app: app, hosts: hosts)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        if let rules { config.userContentController.add(rules) }
        config.userContentController.add(self, name: "log")
        // Hidden and offscreen: it never joins the view hierarchy.
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        box.view = view
        boxes[app] = box
        scheduleEvict(app: app)
        view.loadHTMLString(Self.pageHTML(hosts: hosts), baseURL: nil)
        return box
    }

    private func drop(app: String) {
        guard let box = boxes.removeValue(forKey: app) else { return }
        box.pageGen += 1
        tearDown(box)
        let waiters = box.waiters
        box.waiters = []
        for waiter in waiters { waiter.resume(returning: "Sandbox closed") }
    }

    private func tearDown(_ box: Box) {
        if let view = box.view {
            view.stopLoading()
            view.navigationDelegate = nil
            view.uiDelegate = nil
            view.configuration.userContentController.removeScriptMessageHandler(forName: "log")
            box.view = nil
        }
    }

    private func box(for view: WKWebView) -> Box? {
        boxes.values.first { $0.view === view }
    }

    /// Nil when the page loaded; the load's error message when it failed (the box is
    /// then already dropped, so the next call builds a fresh sandbox).
    private func waitReady(_ box: Box) async -> String? {
        if box.ready { return nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            box.waiters.append(continuation)
        }
    }

    /// Drops the sandbox after 2 minutes without a call; each use reschedules.
    private func scheduleEvict(app: String) {
        guard let box = boxes[app] else { return }
        box.lastUse = Date()
        box.evictGen += 1
        let gen = box.evictGen
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: Self.idleNanoseconds)
            guard let current = self.boxes[app], current.evictGen == gen,
                  Date().timeIntervalSince(current.lastUse) >= 120 else { return }
            self.drop(app: app)
        }
    }

    // MARK: - The page

    private static func pageHTML(hosts: [String]) -> String {
        let connect = hosts.isEmpty ? "'none'" : hosts.map { "https://" + $0 }.joined(separator: " ")
        return """
        <!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src \(connect)"><script>\(shimJS)</script></head><body></body></html>
        """
    }

    /// Forwards `console` to the `log` message handler; the scripts live beside it.
    private static let shimJS = """
    window.__jigScripts = {};
    (function () {
      function text(args) {
        return Array.prototype.map.call(args, function (a) {
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(" ");
      }
      function post(level, args) {
        try { window.webkit.messageHandlers.log.postMessage(level + " " + text(args)); } catch (e) {}
      }
      window.console = {
        log: function () { post("log", arguments); },
        info: function () { post("info", arguments); },
        warn: function () { post("warn", arguments); },
        error: function () { post("error", arguments); },
        debug: function () { post("debug", arguments); }
      };
    })();
    """

    /// Runs `code` with its own `exports`, kept in the page-global map by script name.
    private static func loadSource(script: String, code: String) -> String {
        "window.__jigScripts[\(jsString(script))] = (function () { var exports = {};\n" + code + "\n; return exports; })();"
    }

    /// Calls `exports[fn](input)` and answers a JSON envelope with the result's JSON
    /// or the exception's message, as a returned Promise the host awaits.
    /// `JSON.stringify` of the result can throw (a cycle, a BigInt), so that too is
    /// caught inside the wrapper and answered as a failure.
    private static let callBody = """
    return Promise.resolve().then(function () {
      var table = window.__jigScripts[scriptName];
      var fn = table ? table[fnName] : undefined;
      if (typeof fn !== "function") throw new Error("No '" + fnName + "' in script '" + scriptName + "'");
      return fn(input);
    }).then(function (out) {
      var json;
      try { json = JSON.stringify(out); } catch (e) {
        var msg = (e && e.message) ? String(e.message) : String(e);
        return JSON.stringify({ ok: false, message: msg, error: msg });
      }
      if (json === undefined) json = "null";
      return JSON.stringify({ ok: true, json: json });
    }, function (e) {
      var msg = (e && e.message) ? String(e.message) : String(e);
      return JSON.stringify({ ok: false, message: msg, error: msg });
    });
    """

    private static func jsString(_ value: String) -> String {
        var s = ((try? JSONSerialization.data(withJSONObject: [value])).flatMap { String(data: $0, encoding: .utf8) } ?? #"[""]"#)
        if s.hasPrefix("["), s.hasSuffix("]") { s.removeFirst(); s.removeLast() }
        return s
    }

    /// Hostnames from `network: {allow}`, kept to what a CSP host can carry.
    private static func hosts(from args: [String: Any]) -> [String] {
        let allow = (args["network"] as? [String: Any])?["allow"] as? [String] ?? []
        var seen = Set<String>()
        var out: [String] = []
        for raw in allow {
            let host = raw.lowercased()
            guard !host.isEmpty, host.allSatisfy({ "abcdefghijklmnopqrstuvwxyz0123456789.-".contains($0) }) else { continue }
            if seen.insert(host).inserted { out.append(host) }
        }
        return out.sorted()
    }

    // MARK: - Network rules

    /// Blocks document and subresource loads over http(s); fetches ("raw") stay
    /// governed by the page's CSP `connect-src`, which is rebuilt per host set, while
    /// the blank sandbox page itself never matches. Compiled once, then attached to
    /// every sandbox (also ones already open).
    private static let ruleJSON = """
    [{"trigger":{"url-filter":"^https?://","resource-type":["document","image","style-sheet","script","font","media","svg-document","popup"]},"action":{"type":"block"}}]
    """

    /// Waits for the one-time rule compile; calls that arrive meanwhile queue here so
    /// no page loads without its rules. A failed compile still resumes (unprotected
    /// loads are denied by the navigation policy and CSP) and retries next time.
    private func waitForRules() async {
        if rules != nil { return }
        compileRulesOnce()
        if rules != nil { return }
        guard compilingRules else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            ruleWaiters.append(continuation)
        }
    }

    private func compileRulesOnce() {
        guard rules == nil, !compilingRules else { return }
        guard let store = WKContentRuleListStore.default() else { return }
        compilingRules = true
        store.compileContentRuleList(forIdentifier: "jig-sandbox", encodedContentRuleList: Self.ruleJSON) { list, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    Sandboxes.shared.useRules(list)
                }
            }
        }
    }

    private func useRules(_ list: WKContentRuleList?) {
        if let list {
            rules = list
            for box in boxes.values {
                box.view?.configuration.userContentController.add(list)
            }
        } else {
            compilingRules = false
        }
        let waiters = ruleWaiters
        ruleWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Before ready only the initial blank page may load (loadHTMLString with a nil
        // baseURL shows as about:blank); everything else, and everything after ready,
        // is denied.
        guard let box = box(for: webView), !box.ready else { return decisionHandler(.cancel) }
        guard let frame = navigationAction.targetFrame, frame.isMainFrame else { return decisionHandler(.cancel) }
        decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let box = box(for: webView) else { return }
        box.ready = true
        let waiters = box.waiters
        box.waiters = []
        for waiter in waiters { waiter.resume(returning: nil) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(boxFor: webView, error: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(boxFor: webView, error: error)
    }

    /// A failed load drops the box and answers the waiting call with the load error;
    /// the next call creates a fresh sandbox instead of reusing the broken view.
    private func fail(boxFor view: WKWebView, error: Error) {
        guard let app = boxes.first(where: { $0.value.view === view })?.key,
              let box = boxes.removeValue(forKey: app) else { return }
        box.pageGen += 1
        tearDown(box)
        let message = (error as NSError).localizedDescription
        let waiters = box.waiters
        box.waiters = []
        for waiter in waiters { waiter.resume(returning: message) }
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // JavaScript can't open windows.
        nil
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "log", let view = message.webView, let box = box(for: view) else { return }
        NSLog("[jig %@] %@", box.app, message.body as? String ?? String(describing: message.body))
    }
}

/// One app's sandbox: its hidden web view, the hosts its page allows, and which
/// script hashes already live in the page.
@MainActor
private final class Box {
    let app: String
    var hosts: [String]
    var view: WKWebView?
    var ready = false
    var loaded: [String: String] = [:]
    var waiters: [CheckedContinuation<String?, Never>] = []
    var lastUse = Date()
    var evictGen = 0
    var pageGen = 0

    init(app: String, hosts: [String]) {
        self.app = app
        self.hosts = hosts
    }
}

/// A call's exactly-once gate, confined to the call's MainActor tasks.
private final class AnswerGate: @unchecked Sendable {
    var claimed = false
}

/// JSON-plist values crossing into a MainActor task.
private struct AnyBox: @unchecked Sendable {
    let value: Any?
    init(_ value: Any?) { self.value = value }
}
