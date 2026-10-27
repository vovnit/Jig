import CoreLocation
import Foundation

/// Coarse location updates for things like sunrise times (`location.watch` / `location.stop`).
/// The first `watch` asks for when-in-use permission, then every position fix goes to JS as
/// progress `{lat, lon, accuracy}` (degrees, metres). The call never answers `done` with a
/// result: only `stop` (or a second `watch`, or an error) ends it, with `done({})`.
@MainActor
final class LocationWatch: NSObject, CLLocationManagerDelegate {
    static let shared = LocationWatch()

    private let manager = CLLocationManager()
    private var done: (@Sendable (String) -> Void)?
    private var progress: (@Sendable (String) -> Void)?
    /// Set while waiting for the permission answer a `watch` asked for.
    private var waitingAuth = false

    private override init() {
        super.init()
        manager.delegate = self
        // Coarse is enough (a few hundred metres): it's for sun times and sundials.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func watch(done: @escaping @Sendable (String) -> Void, progress: @escaping @Sendable (String) -> Void) {
        replace(done: done, progress: progress)
        guard CLLocationManager.locationServicesEnabled() else {
            return finish(error: "Location services are turned off")
        }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.startUpdatingLocation()
        case .denied, .restricted:
            finish(error: "Location access is off for Jig in Settings")
        case .notDetermined:
            waitingAuth = true
            manager.requestWhenInUseAuthorization()
        @unknown default:
            waitingAuth = true
            manager.requestWhenInUseAuthorization()
        }
    }

    func stop(done: @escaping @Sendable (String) -> Void) {
        replace(done: nil, progress: nil)
        done(Services.result([:]))
    }

    /// Ends the current watch with `done({})`, if any, and keeps the replacements.
    private func replace(done: (@Sendable (String) -> Void)?, progress: (@Sendable (String) -> Void)?) {
        manager.stopUpdatingLocation()
        waitingAuth = false
        let old = self.done
        self.done = nil
        self.progress = nil
        if let old { old(Services.result([:])) }
        self.done = done
        self.progress = progress
    }

    private func finish(error: String) {
        manager.stopUpdatingLocation()
        waitingAuth = false
        guard let done else { return }
        self.done = nil
        progress = nil
        done(Services.error(error))
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard waitingAuth else { return }
        waitingAuth = false
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.startUpdatingLocation()
        case .denied, .restricted, .notDetermined:
            finish(error: "Location access is off for Jig in Settings")
        @unknown default:
            finish(error: "Location access is off for Jig in Settings")
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let progress, let fix = locations.last else { return }
        progress(Services.encode(["lat": fix.coordinate.latitude, "lon": fix.coordinate.longitude, "accuracy": fix.horizontalAccuracy]))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A fix that never arrives (indoors, no signal) isn't an error yet; keep waiting for one.
        if (error as? CLError)?.code == .locationUnknown { return }
        finish(error: (error as? CLError)?.code == .denied ? "Location access is off for Jig in Settings" : error.localizedDescription)
    }
}

/// Compass headings for aligning a sundial (`heading.watch` / `heading.stop`): progress
/// `{degrees, accuracy}` clockwise from north (true north when known, else magnetic;
/// accuracy in degrees, -1 when unknown), throttled to about 10 a second and only when it
/// moved by at least a degree. Ends like `LocationWatch`.
@MainActor
final class HeadingWatch: NSObject, CLLocationManagerDelegate {
    static let shared = HeadingWatch()

    private let manager = CLLocationManager()
    private var done: (@Sendable (String) -> Void)?
    private var progress: (@Sendable (String) -> Void)?
    private var lastDegrees: Double?
    private var lastTime: TimeInterval = 0

    private override init() {
        super.init()
        manager.delegate = self
        manager.headingFilter = 1
    }

    func watch(done: @escaping @Sendable (String) -> Void, progress: @escaping @Sendable (String) -> Void) {
        replace(done: done, progress: progress)
        guard CLLocationManager.headingAvailable() else {
            return finish(error: "This device has no compass")
        }
        // Magnetic heading needs no permission: start at once, using true north only
        // when the platform knows it (`trueHeading >= 0`, below).
        manager.startUpdatingHeading()
    }

    func stop(done: @escaping @Sendable (String) -> Void) {
        replace(done: nil, progress: nil)
        done(Services.result([:]))
    }

    private func replace(done: (@Sendable (String) -> Void)?, progress: (@Sendable (String) -> Void)?) {
        manager.stopUpdatingHeading()
        lastDegrees = nil
        let old = self.done
        self.done = nil
        self.progress = nil
        if let old { old(Services.result([:])) }
        self.done = done
        self.progress = progress
    }

    private func finish(error: String) {
        manager.stopUpdatingHeading()
        guard let done else { return }
        self.done = nil
        progress = nil
        done(Services.error(error))
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
        guard let progress else { return }
        // True north when the platform knows it, else magnetic.
        let degrees = heading.trueHeading >= 0 ? heading.trueHeading : heading.magneticHeading
        let accuracy = heading.headingAccuracy >= 0 ? heading.headingAccuracy : -1
        let now = Date().timeIntervalSince1970
        if let last = lastDegrees {
            let turn = abs(degrees - last).truncatingRemainder(dividingBy: 360)
            let diff = turn > 180 ? 360 - turn : turn
            if diff < 1 || now - lastTime < 0.1 { return }
        }
        lastDegrees = degrees
        lastTime = now
        progress(Services.encode(["degrees": degrees, "accuracy": accuracy]))
    }
}
