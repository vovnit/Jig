import UIKit

/// Root surface for the Jig runtime: owns the UIKit renderer and the JS runtime,
/// keeps the runtime's viewport, keyboard and appearance in sync, and switches
/// between bundled app specs.
final class HostViewController: UIViewController {
    private struct BundledApp {
        let id: String
        let name: String
        let json: String
    }

    private var renderer: UIKitRenderer!
    private var runtime: JigRuntime!
    private var apps: [BundledApp] = []
    private var lastViewport: (CGSize, UIEdgeInsets)?
    private var keyboardOverlap: CGFloat = 0
    private let menuButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        renderer = UIKitRenderer(surface: view)
        runtime = JigRuntime(renderer: renderer)
        runtime.onTheme = { [weak self] theme in self?.apply(theme) }
        apps = Self.loadBundledApps()

        setUpMenuButton()
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

        let lastId = UserDefaults.standard.string(forKey: "jig.lastApp")
        if let app = apps.first(where: { $0.id == lastId }) ?? apps.first { open(app) }
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

    private func open(_ app: BundledApp) {
        runtime.load(specJSON: app.json)
        UserDefaults.standard.set(app.id, forKey: "jig.lastApp")
        menuButton.menu = UIMenu(title: "Apps", children: apps.map { a in
            UIAction(title: a.name, state: a.id == app.id ? .on : .off) { [weak self] _ in self?.open(a) }
        })
        view.bringSubviewToFront(menuButton)
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

    @objc private func handleBackSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended else { return }
        let dx = gesture.translation(in: view).x
        let vx = gesture.velocity(in: view).x
        if dx > view.bounds.width * 0.3 || vx > 500 { runtime.goBack() }
    }

    // MARK: - App switcher

    private func setUpMenuButton() {
        menuButton.setImage(UIImage(systemName: "square.grid.2x2"), for: .normal)
        menuButton.tintColor = .secondaryLabel
        menuButton.showsMenuAsPrimaryAction = true
        menuButton.accessibilityLabel = "Switch app"
        menuButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(menuButton)
        NSLayoutConstraint.activate([
            menuButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            menuButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            menuButton.widthAnchor.constraint(equalToConstant: 44),
            menuButton.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private static func loadBundledApps() -> [BundledApp] {
        let urls = Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? []
        return urls.compactMap { url -> BundledApp? in
            guard let data = try? Data(contentsOf: url),
                  let spec = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  spec["screens"] != nil,
                  let id = spec["id"] as? String,
                  let json = String(data: data, encoding: .utf8)
            else { return nil }
            return BundledApp(id: id, name: spec["name"] as? String ?? id, json: json)
        }
        .sorted { $0.name < $1.name }
    }
}
