import AVFoundation
import Foundation
import UIKit

/// Host services for the shell (`Host.call` in the runtime): HTTP for the model and audio
/// for spoken requests (screenshots need the renderer; JigRuntime handles those). Each call
/// answers once with JSON, `{"result": ...}` or `{"error": "..."}`, on any thread, after any
/// number of progress updates (a streamed body's lines).
nonisolated enum Services {
    static func handle(_ service: String, argsJSON: String, done: @escaping @Sendable (String) -> Void, progress: @escaping @Sendable (String) -> Void) {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJSON.utf8))) as? [String: Any] ?? [:]
        switch service {
        case "widgets.set":
            DispatchQueue.main.async { MainActor.assumeIsolated { WidgetService.set(args, done: done) } }
        case "schedule.set":
            DispatchQueue.main.async { MainActor.assumeIsolated { ScheduleService.shared.set(args, done: done) } }
        case "http":
            http(args, done: done, progress: progress)
        case "audio.start":
            DispatchQueue.main.async { MainActor.assumeIsolated { Recorder.shared.start(done: done) } }
        case "audio.stop":
            DispatchQueue.main.async { MainActor.assumeIsolated { done(Recorder.shared.stop()) } }
        case "location.watch":
            DispatchQueue.main.async { MainActor.assumeIsolated { LocationWatch.shared.watch(done: done, progress: progress) } }
        case "location.stop":
            DispatchQueue.main.async { MainActor.assumeIsolated { LocationWatch.shared.stop(done: done) } }
        case "heading.watch":
            DispatchQueue.main.async { MainActor.assumeIsolated { HeadingWatch.shared.watch(done: done, progress: progress) } }
        case "heading.stop":
            DispatchQueue.main.async { MainActor.assumeIsolated { HeadingWatch.shared.stop(done: done) } }
        case "haptic":
            DispatchQueue.main.async { MainActor.assumeIsolated { haptic(args, done: done) } }
        case "keepAwake":
            DispatchQueue.main.async { MainActor.assumeIsolated { setKeepAwake(args, done: done) } }
        case "brightness":
            DispatchQueue.main.async { MainActor.assumeIsolated { ScreenBrightness.shared.set(args: args, done: done) } }
        case "speak":
            DispatchQueue.main.async { MainActor.assumeIsolated { Speaker.shared.speak(args: args, done: done) } }
        case "stopSpeaking":
            DispatchQueue.main.async { MainActor.assumeIsolated { Speaker.shared.stop(done: done) } }
        case "zip.list":
            ZipArchive.list(app: args["app"] as? String ?? "", id: args["id"] as? String ?? "", done: done)
        case "zip.read":
            ZipArchive.read(app: args["app"] as? String ?? "", id: args["id"] as? String ?? "", path: args["path"] as? String ?? "", as: args["as"] as? String ?? "text", done: done)
        case "files.write":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.write(args, done: done) } }
        case "files.read":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.read(args, done: done) } }
        case "files.delete":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.delete(args, done: done) } }
        case "files.clear":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.clear(args, done: done) } }
        case "pickFile":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.pickFile(args, done: done) } }
        case "pickPhoto":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.pickPhoto(args, done: done) } }
        case "takePhoto":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.takePhoto(args, done: done) } }
        case "share":
            DispatchQueue.main.async { MainActor.assumeIsolated { FileService.share(args, done: done) } }
        default:
            done(error("No '\(service)' service on iOS"))
        }
    }

    private static func http(_ args: [String: Any], done: @escaping @Sendable (String) -> Void, progress: @escaping @Sendable (String) -> Void) {
        guard let url = (args["url"] as? String).flatMap(URL.init(string:)), url.scheme == "https" || url.scheme == "http" else {
            return done(error("A valid http(s) url is required"))
        }
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.httpMethod = args["method"] as? String ?? "GET"
        for (k, v) in args["headers"] as? [String: String] ?? [:] { request.setValue(v, forHTTPHeaderField: k) }
        if let body = args["body"] as? String { request.httpBody = Data(body.utf8) }
        if args["stream"] as? Bool == true {
            // Server-sent events: each line goes to JS as it arrives (`lines` skips the blank
            // separators, which carry nothing).
            let request = request
            Task {
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    for try await line in bytes.lines { progress(encode(["line": line])) }
                    done(result(["status": (response as? HTTPURLResponse)?.statusCode ?? 0, "body": ""]))
                } catch {
                    done(Services.error(error.localizedDescription))
                }
            }
            return
        }
        URLSession.shared.dataTask(with: request) { data, response, err in
            if let err { return done(error(err.localizedDescription)) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            done(result(["status": status, "body": String(decoding: data ?? Data(), as: UTF8.self)]))
        }.resume()
    }

    static func result(_ value: Any) -> String { encode(["result": value]) }
    static func error(_ message: String) -> String { encode(["error": message]) }

    @MainActor
    private static func haptic(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        switch args["style"] as? String {
        case "light":
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "medium":
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "heavy":
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "success":
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning":
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error":
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        default:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        done(result([:]))
    }

    @MainActor
    private static func setKeepAwake(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        UIApplication.shared.isIdleTimerDisabled = args["on"] as? Bool == true
        done(result([:]))
    }

    static func encode(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data(#"{"error":"Unencodable result"}"#.utf8)
        return String(decoding: data, as: UTF8.self)
    }
}

/// Screen brightness (0..1); `null` restores the system's. The original level is
/// remembered on the first set, so restoring gives back what was there.
@MainActor
final class ScreenBrightness {
    static let shared = ScreenBrightness()
    private var original: CGFloat?
    private init() {}

    func set(args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        if let level = (args["level"] as? NSNumber)?.doubleValue {
            if original == nil { original = UIScreen.main.brightness }
            UIScreen.main.brightness = CGFloat(min(1, max(0, level)))
        } else if let original {
            UIScreen.main.brightness = original
            self.original = nil
        }
        done(Services.result([:]))
    }
}

/// Speaks text aloud (`speak` / `stopSpeaking`): answers when it finishes or is
/// stopped. `rate` 0.5..2, default 1 (normal speed).
@MainActor
final class Speaker: NSObject, @MainActor AVSpeechSynthesizerDelegate {
    static let shared = Speaker()
    private let synthesizer = AVSpeechSynthesizer()
    private var done: (@Sendable (String) -> Void)?
    private var current: AVSpeechUtterance?

    private override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        // A new request ends the previous one with `{}`.
        let previous = self.done
        self.done = nil
        self.current = nil
        synthesizer.stopSpeaking(at: .immediate)
        previous?(Services.result([:]))
        guard let text = args["text"] as? String, !text.isEmpty else {
            return done(Services.error("Nothing to say"))
        }
        let rate = ((args["rate"] as? NSNumber)?.doubleValue).map { min(2, max(0.5, $0)) } ?? 1
        let utterance = AVSpeechUtterance(string: text)
        // The utterance rate is 0..1 around a 0.5 default; map 0.5..2 (1 normal) onto it.
        utterance.rate = Float(rate) * AVSpeechUtteranceDefaultSpeechRate
        self.done = done
        current = utterance
        synthesizer.speak(utterance)
    }

    func stop(done: @escaping @Sendable (String) -> Void) {
        let previous = self.done
        self.done = nil
        current = nil
        synthesizer.stopSpeaking(at: .immediate)
        previous?(Services.result([:]))
        done(Services.result([:]))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        // A late callback for a replaced utterance answers nothing.
        guard utterance === current else { return }
        current = nil
        let done = self.done
        self.done = nil
        done?(Services.result([:]))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // `stopSpeaking(at:)` reports a cancel too; a fresh `speak` or `stop`
        // answers the previous one itself, so only answer if nobody did.
        guard utterance === current else { return }
        current = nil
        let done = self.done
        self.done = nil
        done?(Services.result([:]))
    }
}

/// Records the microphone as 16 kHz mono 16-bit WAV, the format the model is sent.
@MainActor
final class Recorder {
    static let shared = Recorder()
    private var recorder: AVAudioRecorder?
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("jig-voice.wav")

    func start(done: @escaping @Sendable (String) -> Void) {
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard granted else { return done(Services.error("Microphone access is off for Jig in Settings")) }
                    do {
                        let session = AVAudioSession.sharedInstance()
                        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                        try session.setActive(true)
                        let recorder = try AVAudioRecorder(url: self.url, settings: [
                            AVFormatIDKey: kAudioFormatLinearPCM,
                            AVSampleRateKey: 16000,
                            AVNumberOfChannelsKey: 1,
                            AVLinearPCMBitDepthKey: 16,
                            AVLinearPCMIsFloatKey: false,
                        ])
                        guard recorder.record() else { return done(Services.error("Recording didn't start")) }
                        self.recorder = recorder
                        done(Services.result([:]))
                    } catch {
                        done(Services.error(error.localizedDescription))
                    }
                }
            }
        }
    }

    func stop() -> String {
        guard let recorder else { return Services.error("Not recording") }
        recorder.stop()
        self.recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let data = try? Data(contentsOf: url) else { return Services.error("Nothing was recorded") }
        return Services.result(["data": data.base64EncodedString()])
    }
}
