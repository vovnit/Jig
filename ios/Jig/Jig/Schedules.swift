import Foundation
import UserNotifications
import AlarmKit
import AppIntents
import SwiftUI
import CryptoKit

@MainActor
final class ScheduleService: NSObject, @MainActor UNUserNotificationCenterDelegate {
    static let shared = ScheduleService()
    var onOpen: ((String, String) -> Void)? {
        didSet { if let pending, let onOpen { self.pending = nil; onOpen(pending.0, pending.1) } }
    }
    private var pending: (String, String)?
    private var tail: Task<Void, Never>?
    private let center = UNUserNotificationCenter.current()
    private var saved: [String: [[String: Any]]] = UserDefaults.standard.dictionary(forKey: "jig.schedules") as? [String: [[String: Any]]] ?? [:]
    override private init() { super.init(); center.delegate = self }
    func open(app: String, screen: String) {
        if let onOpen { onOpen(app, screen) } else { pending = (app, screen) }
    }
    func set(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        let previous = tail
        tail = Task {
            await previous?.value
            do {
                let app = args["app"] as? String ?? ""
                guard !app.isEmpty else { throw ScheduleError.invalid }
                let items = args["items"] as? [[String: Any]] ?? []
                if !items.isEmpty {
                    guard try await center.requestAuthorization(options: [.alert, .sound, .badge]) else { throw ScheduleError.denied }
                }
                saved[app] = items
                UserDefaults.standard.set(saved, forKey: "jig.schedules")
                try await reconcile()
                done(Services.result([:]))
            } catch { done(Services.error(error.localizedDescription)) }
        }
    }
    private func reconcile() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let items = saved.values.flatMap { $0 }.filter { ($0["at"] as? Double ?? 0) > now }
            .sorted { ($0["at"] as? Double ?? 0) < ($1["at"] as? Double ?? 0) }.prefix(64)
        let old = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix("jig:") }
        let ids = Set(items.map { identifier($0) })
        center.removePendingNotificationRequests(withIdentifiers: old.filter { !ids.contains($0.identifier) }.map(\.identifier))
        var oldAlarms = UserDefaults.standard.stringArray(forKey: "jig.alarmIDs") ?? []
        let newAlarms = items.filter { $0["alarm"] as? Bool == true }.map { alarmID(identifier($0)).uuidString }
        if #available(iOS 26.0, *) {
            for id in oldAlarms where !newAlarms.contains(id) { if let uuid = UUID(uuidString: id) { try? AlarmManager.shared.cancel(id: uuid) } }
        }
        oldAlarms = []
        for item in items {
            let id = identifier(item)
            let date = Date(timeIntervalSince1970: (item["at"] as? Double ?? 0) / 1000)
            if #available(iOS 26.0, *), item["alarm"] as? Bool == true {
                guard try await AlarmManager.shared.requestAuthorization() == .authorized else { throw ScheduleError.denied }
                let uuid = alarmID(id)
                let title = LocalizedStringResource(stringLiteral: item["title"] as? String ?? "Jig")
                let alert = AlarmPresentation.Alert(title: title, stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.fill"), secondaryButton: AlarmButton(text: "Open", textColor: .white, systemImageName: "arrow.up.forward.app"), secondaryButtonBehavior: .custom)
                let attributes = AlarmAttributes<JigAlarmMetadata>(presentation: AlarmPresentation(alert: alert), metadata: JigAlarmMetadata(), tintColor: .blue)
                let config = AlarmManager.AlarmConfiguration.alarm(schedule: .fixed(date), attributes: attributes, secondaryIntent: OpenJigAlarm(app: item["app"] as? String ?? "", screen: item["open"] as? String ?? ""))
                try? AlarmManager.shared.cancel(id: uuid)
                _ = try await AlarmManager.shared.schedule(id: uuid, configuration: config)
                oldAlarms.append(uuid.uuidString)
                UserDefaults.standard.set(oldAlarms, forKey: "jig.alarmIDs")
                center.removePendingNotificationRequests(withIdentifiers: [id])
                continue
            }
            let content = UNMutableNotificationContent()
            content.title = item["title"] as? String ?? "Jig"
            content.body = item["body"] as? String ?? ""
            content.userInfo = ["app": item["app"] as? String ?? "", "open": item["open"] as? String ?? ""]
            if let sound = item["sound"] as? String, ["@chime", "@gentle", "@alarm"].contains(sound) {
                content.sound = UNNotificationSound(named: UNNotificationSoundName(String(sound.dropFirst()) + ".wav"))
            } else { content.sound = .default }
            if item["alarm"] as? Bool == true { content.interruptionLevel = .timeSensitive }
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, date.timeIntervalSinceNow), repeats: false)
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
        UserDefaults.standard.set(oldAlarms, forKey: "jig.alarmIDs")
    }
    private func identifier(_ item: [String: Any]) -> String { "jig:\(item["app"] ?? ""):\(item["id"] ?? "")" }
    private func alarmID(_ key: String) -> UUID {
        let hex = SHA256.hash(data: Data(key.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        let chars = Array(hex)
        let value = [String(chars[0..<8]), String(chars[8..<12]), String(chars[12..<16]), String(chars[16..<20]), String(chars[20..<32])].joined(separator: "-")
        return UUID(uuidString: value)!
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        open(app: info["app"] as? String ?? "", screen: info["open"] as? String ?? "")
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
}
private enum ScheduleError: LocalizedError {
    case invalid, denied
    var errorDescription: String? { self == .denied ? "Notification or alarm permission was denied." : "Invalid schedule." }
}
@available(iOS 26.0, *)
private struct JigAlarmMetadata: AlarmMetadata {}
@available(iOS 26.0, *)
struct OpenJigAlarm: LiveActivityIntent {
    static let title: LocalizedStringResource = "Open Jig app"
    static var openAppWhenRun: Bool { true }
    @Parameter(title: "App") var app: String
    @Parameter(title: "Screen") var screen: String
    init() {}
    init(app: String, screen: String) { self.app = app; self.screen = screen }
    func perform() async throws -> some IntentResult {
        await ScheduleService.shared.open(app: app, screen: screen)
        return .result()
    }
}
