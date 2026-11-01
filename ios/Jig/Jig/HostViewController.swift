import UIKit

/// Root surface for the Jig runtime: owns the UIKit renderer and the JS runtime, keeps the
/// runtime's viewport, keyboard and appearance in sync, and starts the shell, whose list of
/// apps the bundled demo specs seed.
final class HostViewController: UIViewController {
    private var renderer: UIKitRenderer!
    private var runtime: JigRuntime!
    private var lastViewport: (CGSize, UIEdgeInsets)?
    private var keyboardOverlap: CGFloat = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        // Demo mode (a scripted take for the demo video): `-jigDemo <name>` on launch.
        let demoName = UserDefaults.standard.string(forKey: "jigDemo")
        renderer = UIKitRenderer(surface: view)
        runtime = JigRuntime(renderer: renderer, demo: demoName?.isEmpty == false)
        FileService.presenter = self
        runtime.onTheme = { [weak self] theme in self?.apply(theme) }
        setUpBackSwipe()
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil
        )

        // Follow the system appearance; the runtime swaps its color tokens.
        runtime.setColorScheme(dark: traitCollection.userInterfaceStyle == .dark)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _: UITraitCollection) in
            self.runtime.setColorScheme(dark: self.traitCollection.userInterfaceStyle == .dark)
        }

        let (shell, seeds) = Self.bundledSpecs()
        let demoJSON = Self.demoJSON(name: demoName)
        if let demoName, !demoName.isEmpty {
            // Drop the previous take so the record script's polling only finds the new one.
            Self.clearStaleDemoTake(name: demoName)
            // A take runs minutes; the screen stays awake for it.
            UIApplication.shared.isIdleTimerDisabled = true
        }
        runtime.boot(shellJSON: shell, seedsJSON: seeds, demoJSON: demoJSON)
        ScheduleService.shared.onOpen = { [weak self] app, screen in self?.runtime.open(app: app, screen: screen) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateViewport()
    }

    private func updateViewport() {
        let size = view.bounds.size
        var insets = view.safeAreaInsets
        // The keyboard shrinks the app from below; scroll views then keep the focused field in view.
        insets.bottom = max(insets.bottom, keyboardOverlap)
        if let last = lastViewport, last.0 == size, last.1 == insets { return }
        lastViewport = (size, insets)
        runtime.setViewport(size: size, insets: insets)
    }

    private func apply(_ theme: JigRuntime.Theme) {
        renderer.isDark = theme.isDark
        if let accent = theme.colors["accent"].flatMap(UIColor.init(hex:)) { renderer.accentColor = accent }
        if let background = theme.colors["background"].flatMap(UIColor.init(hex:)) { view.backgroundColor = background }
    }

    // MARK: - Keyboard

    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let local = view.convert(frame, from: nil)
        keyboardOverlap = max(0, view.bounds.maxY - local.minY)
        updateViewport()
    }

    // MARK: - Back swipe

    private func setUpBackSwipe() {
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleBackSwipe(_:)))
        edge.edges = .left
        view.addGestureRecognizer(edge)
    }

    private var swipingBack = false

    /// The screen follows the finger; past a third of the width (or on a flick) it pops.
    @objc private func handleBackSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
        let width = max(1, view.bounds.width)
        let dx = gesture.translation(in: view).x
        switch gesture.state {
        case .began:
            swipingBack = renderer.beginInteractiveBack()
        case .changed:
            if swipingBack { renderer.updateInteractiveBack(progress: dx / width) }
        case .ended, .cancelled, .failed:
            let commit = gesture.state == .ended && (dx > width * 0.3 || gesture.velocity(in: view).x > 500)
            if swipingBack {
                renderer.endInteractiveBack(commit: commit) { [weak self] in self?.runtime.goBack() }
            } else if commit, renderer.canGoBack {
                runtime.goBack()
            }
            swipingBack = false
        default:
            break
        }
    }

    // MARK: - Specs

    /// `shell.json`, and every other bundled spec (as a JSON array) for the shell's app list.
    /// Demo scenarios and model reply tapes ride along flat in the bundle; they are
    /// skipped here (tapes are large) and read by `demoJSON` instead.
    private static func bundledSpecs() -> (shell: String, seeds: String) {
        guard let shellURL = Bundle.main.url(forResource: "shell", withExtension: "json"),
              let shell = try? String(contentsOf: shellURL, encoding: .utf8)
        else { fatalError("shell.json is missing from the app bundle. Run `npm run build:native` in the repo root.") }
        let urls = (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [])
            .filter {
                $0.lastPathComponent != "shell.json"
                    && !$0.lastPathComponent.hasPrefix("demo-")
                    && !$0.lastPathComponent.hasPrefix("tape-")
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        let seeds = urls.compactMap { url -> String? in
            guard let data = try? Data(contentsOf: url),
                  let spec = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  spec["screens"] != nil
            else { return nil }
            return String(data: data, encoding: .utf8)
        }
        return (shell, "[" + seeds.joined(separator: ",") + "]")
    }

    /// The demo payload for `__jigBoot`: the scenario's script with its model reply
    /// tape, concatenated as text (not re-serialized). `""` outside demo mode; the
    /// tape is null when the scenario ships without one.
    private static func demoJSON(name: String?) -> String {
        guard let name, !name.isEmpty else { return "" }
        guard let scriptURL = Bundle.main.url(forResource: "demo-\(name)", withExtension: "json"),
              let script = try? String(contentsOf: scriptURL, encoding: .utf8)
        else { fatalError("demo-\(name).json is missing from the app bundle. Run `npm run build:native` in the repo root.") }
        let tape = Bundle.main.url(forResource: "tape-\(name)", withExtension: "json")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "null"
        return "{\"script\":" + script + ",\"tape\":" + tape + "}"
    }

    /// Deletes the previous take for `name`, so the record script polling for
    /// `Documents/demo/<name>.json` only finds the new one.
    private static func clearStaleDemoTake(name: String) {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("demo")
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(name).json"))
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(name).mp4"))
    }
}
