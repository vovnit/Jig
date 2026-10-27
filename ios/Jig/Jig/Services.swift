import AVFoundation
import Foundation

/// Host services for the shell (`Host.call` in the runtime): HTTP for the model and audio
/// for spoken requests (screenshots need the renderer; JigRuntime handles those). Each call
/// answers once with JSON, `{"result": ...}` or `{"error": "..."}`, on any thread.
nonisolated enum Services {
    static func handle(_ service: String, argsJSON: String, done: @escaping @Sendable (String) -> Void) {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJSON.utf8))) as? [String: Any] ?? [:]
        switch service {
        case "http":
            http(args, done: done)
        case "audio.start":
            DispatchQueue.main.async { MainActor.assumeIsolated { Recorder.shared.start(done: done) } }
        case "audio.stop":
            DispatchQueue.main.async { MainActor.assumeIsolated { done(Recorder.shared.stop()) } }
        default:
            done(error("No '\(service)' service on iOS"))
        }
    }

    private static func http(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let url = (args["url"] as? String).flatMap(URL.init(string:)), url.scheme == "https" || url.scheme == "http" else {
            return done(error("A valid http(s) url is required"))
        }
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.httpMethod = args["method"] as? String ?? "GET"
        for (k, v) in args["headers"] as? [String: String] ?? [:] { request.setValue(v, forHTTPHeaderField: k) }
        if let body = args["body"] as? String { request.httpBody = Data(body.utf8) }
        URLSession.shared.dataTask(with: request) { data, response, err in
            if let err { return done(error(err.localizedDescription)) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            done(result(["status": status, "body": String(decoding: data ?? Data(), as: UTF8.self)]))
        }.resume()
    }

    static func result(_ value: Any) -> String { encode(["result": value]) }
    static func error(_ message: String) -> String { encode(["error": message]) }

    private static func encode(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data(#"{"error":"Unencodable result"}"#.utf8)
        return String(decoding: data, as: UTF8.self)
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
