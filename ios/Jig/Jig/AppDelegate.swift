import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        _ = ScheduleService.shared
        return true
    }
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url { open(url) }
    }
    private func open(_ url: URL) {
        guard url.scheme == "jig", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        let app = parts.queryItems?.first(where: { $0.name == "app" })?.value ?? ""
        let screen = parts.queryItems?.first(where: { $0.name == "screen" })?.value ?? ""
        ScheduleService.shared.open(app: app, screen: screen)
    }


    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = HostViewController()
        #if DEBUG
        // `-animationSpeed 0.1` slows every animation down, for checking transitions.
        let speed = UserDefaults.standard.double(forKey: "animationSpeed")
        if speed > 0 { window.layer.speed = Float(speed) }
        #endif
        window.makeKeyAndVisible()
        self.window = window
        if let url = connectionOptions.urlContexts.first?.url { open(url) }
    }
}
