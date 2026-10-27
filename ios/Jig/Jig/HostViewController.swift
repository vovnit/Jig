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
        renderer = UIKitRenderer(surface: view)
        runtime = JigRuntime(renderer: renderer)
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
        runtime.boot(shellJSON: shell, seedsJSON: seeds)
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
    private static func bundledSpecs() -> (shell: String, seeds: String) {
        guard let shellURL = Bundle.main.url(forResource: "shell", withExtension: "json"),
              let shell = try? String(contentsOf: shellURL, encoding: .utf8)
        else { fatalError("shell.json is missing from the app bundle. Run `npm run build:native` in the repo root.") }
        let urls = (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [])
            .filter { $0.lastPathComponent != "shell.json" }
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
}
