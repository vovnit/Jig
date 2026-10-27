import AVFoundation
import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// A per-app file store, behind `files.*` and the pickers: Application Support/files/<app>/
/// with a small JSON index of the handles. Pickers copy into it; `jig-file:<app>/<id>`
/// loads from it; deleting the app clears it.
nonisolated enum FileStore {
    struct Handle: Codable {
        var id: String
        var name: String
        var type: String
        var size: Int
    }

    static func directory(app: String) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("files", isDirectory: true)
            .appendingPathComponent(app, isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    private static func indexURL(app: String) -> URL {
        directory(app: app).appendingPathComponent("index.json")
    }

    private static func readIndex(app: String) -> [Handle] {
        guard let data = try? Data(contentsOf: indexURL(app: app)),
              let handles = try? JSONDecoder().decode([Handle].self, from: data)
        else { return [] }
        return handles
    }

    private static func saveIndex(app: String, _ handles: [Handle]) {
        try? JSONEncoder().encode(handles).write(to: indexURL(app: app), options: .atomic)
    }

    static func dict(_ h: Handle) -> [String: Any] {
        ["id": h.id, "name": h.name, "type": h.type, "size": h.size]
    }

    static func handle(app: String, id: String) -> Handle? {
        readIndex(app: app).first { $0.id == id }
    }

    /// A temporary copy of a stored file named with the handle's original `name`, for
    /// the share sheet (so the receiver sees "book.epub", not the store id).
    static func shareCopy(app: String, id: String) -> URL? {
        guard let data = try? Data(contentsOf: directory(app: app).appendingPathComponent(id)) else { return nil }
        let raw = handle(app: app, id: id)?.name ?? id
        let filename = (raw as NSString).lastPathComponent
        let name = filename.isEmpty ? id : filename
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("jig-share-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url
    }

    private static func freshID(app: String) -> String {
        let known = Set(readIndex(app: app).map(\.id))
        var id = ""
        repeat {
            id = "f\(UUID().uuidString.prefix(8).lowercased())"
        } while known.contains(id)
        return id
    }

    /// Stores bytes, returning the handle.
    static func write(app: String, name: String, type: String, data: Data) -> [String: Any] {
        let dir = directory(app: app)
        let id = freshID(app: app)
        try? data.write(to: dir.appendingPathComponent(id), options: .atomic)
        let handle = Handle(id: id, name: name, type: type, size: data.count)
        saveIndex(app: app, readIndex(app: app).filter { $0.id != id } + [handle])
        return dict(handle)
    }

    /// The bytes of a stored file, sliced to `offset`/`length` when given.
    static func read(app: String, id: String, offset: Int = 0, length: Int? = nil) -> Data? {
        guard let data = try? Data(contentsOf: directory(app: app).appendingPathComponent(id)) else { return nil }
        let start = max(0, min(offset, data.count))
        let end = length.map { max(start, min(data.count, start + $0)) } ?? data.count
        return data[start..<end]
    }

    /// A file URL for players and the share sheet (nil when the file is gone).
    static func fileURL(app: String, id: String) -> URL? {
        let url = directory(app: app).appendingPathComponent(id)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    static func remove(app: String, id: String) {
        try? FileManager.default.removeItem(at: directory(app: app).appendingPathComponent(id))
        saveIndex(app: app, readIndex(app: app).filter { $0.id != id })
    }

    static func clear(app: String) {
        try? FileManager.default.removeItem(at: directory(app: app))
    }

    /// A picked photo as JPEG data whose long side is at most 2048 px.
    static func downscaledJPEG(_ image: UIImage, maxSide: CGFloat = 2048) -> Data? {
        let pixels = CGSize(width: CGFloat(image.cgImage?.width ?? Int(image.size.width)), height: CGFloat(image.cgImage?.height ?? Int(image.size.height)))
        let scale = min(1, maxSide / max(pixels.width, pixels.height))
        let size = CGSize(width: max(1, pixels.width * scale), height: max(1, pixels.height * scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return resized.jpegData(compressionQuality: 0.92)
    }
}

/// The file services (`files.*`, pickers, share). Presented from the hosting view
/// controller, which sets itself as the presenter on launch.
final class FileService {
    private init() {}
    static weak var presenter: UIViewController?
    /// Coordinators alive while their system UI is up (delegates are weak).
    private static var active: [AnyObject] = []

    private static func retain(_ object: AnyObject) { active.append(object) }
    private static func release(_ object: AnyObject) { active.removeAll { $0 === object } }

    private static func viewController(done: @escaping @Sendable (String) -> Void) -> UIViewController? {
        guard let vc = presenter else {
            done(Services.error("No view to show the picker from"))
            return nil
        }
        return vc
    }

    // MARK: - files.*

    static func write(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let app = args["app"] as? String, !app.isEmpty else { return done(Services.error("A file needs an app")) }
        let data: Data
        if let b64 = args["data"] as? String {
            guard let decoded = Data(base64Encoded: b64) else { return done(Services.error("Bad file data")) }
            data = decoded
        } else {
            data = Data()
        }
        done(Services.result(FileStore.write(app: app, name: args["name"] as? String ?? "file", type: args["type"] as? String ?? "application/octet-stream", data: data)))
    }

    static func read(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let app = args["app"] as? String, let id = args["id"] as? String else { return done(Services.error("A file needs an app and an id")) }
        let offset = (args["offset"] as? NSNumber)?.intValue ?? 0
        let length = (args["length"] as? NSNumber)?.intValue
        guard let data = FileStore.read(app: app, id: id, offset: offset, length: length) else { return done(Services.error("No such file")) }
        if (args["as"] as? String) == "base64" {
            done(Services.result(["data": data.base64EncodedString()]))
        } else if let text = String(data: data, encoding: .utf8) {
            done(Services.result(["data": text]))
        } else {
            done(Services.error("The file isn't text"))
        }
    }

    static func delete(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        if let app = args["app"] as? String, let id = args["id"] as? String { FileStore.remove(app: app, id: id) }
        done(Services.result([:]))
    }

    static func clear(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        if let app = args["app"] as? String { FileStore.clear(app: app) }
        done(Services.result([:]))
    }

    // MARK: - pickFile

    /// Extensions ("epub") and MIME patterns ("image/*") to document types.
    private static func contentTypes(for accept: [String]) -> [UTType] {
        if accept.isEmpty { return [.data] }
        var out: [UTType] = []
        for entry in accept {
            if entry.hasSuffix("/*") {
                switch entry {
                case "image/*": out.append(.image)
                case "video/*": out.append(.movie)
                case "audio/*": out.append(.audio)
                case "text/*": out.append(.plainText)
                default: out.append(.data)
                }
            } else if entry.contains("/") {
                out.append(UTType(mimeType: entry) ?? .data)
            } else {
                let ext = entry.hasPrefix(".") ? String(entry.dropFirst()) : entry
                out.append(UTType(filenameExtension: ext.lowercased()) ?? .data)
            }
        }
        return out.isEmpty ? [.data] : out
    }

    static func pickFile(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let vc = viewController(done: done) else { return }
        guard let app = args["app"] as? String, !app.isEmpty else { return done(Services.error("A file needs an app")) }
        let multiple = args["multiple"] as? Bool == true
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: contentTypes(for: args["accept"] as? [String] ?? []), asCopy: true)
        picker.allowsMultipleSelection = multiple
        let coordinator = DocumentCoordinator(app: app, multiple: multiple, done: done)
        picker.delegate = coordinator
        retain(coordinator)
        vc.present(picker, animated: true)
    }

    private final class DocumentCoordinator: NSObject, UIDocumentPickerDelegate {
        let app: String
        let multiple: Bool
        let done: (@Sendable (String) -> Void)
        init(app: String, multiple: Bool, done: @escaping @Sendable (String) -> Void) {
            self.app = app
            self.multiple = multiple
            self.done = done
        }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            finish(with: urls)
        }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            finish(error: "Cancelled")
        }
        private func finish(with urls: [URL] = [], error: String? = nil) {
            FileService.release(self)
            if let error { return done(Services.error(error)) }
            var handles: [[String: Any]] = []
            for url in urls {
                guard url.startAccessingSecurityScopedResource() else { continue }
                defer { url.stopAccessingSecurityScopedResource() }
                guard let data = try? Data(contentsOf: url) else { continue }
                let ext = url.pathExtension
                let type = (ext.isEmpty ? nil : UTType(filenameExtension: ext)?.preferredMIMEType) ?? "application/octet-stream"
                handles.append(FileStore.write(app: app, name: url.lastPathComponent, type: type, data: data))
            }
            guard !handles.isEmpty else { return done(Services.error("Couldn't read the file")) }
            done(Services.result(multiple ? handles : handles[0]))
        }
    }

    // MARK: - pickPhoto

    static func pickPhoto(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let vc = viewController(done: done) else { return }
        guard let app = args["app"] as? String, !app.isEmpty else { return done(Services.error("A photo needs an app")) }
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        // No photo library permission needed for the picker.
        config.selectionLimit = args["multiple"] as? Bool == true ? 0 : 1
        let picker = PHPickerViewController(configuration: config)
        let coordinator = PhotoCoordinator(app: app, multiple: args["multiple"] as? Bool == true, done: done)
        picker.delegate = coordinator
        retain(coordinator)
        vc.present(picker, animated: true)
    }

    private final class PhotoCoordinator: NSObject, PHPickerViewControllerDelegate {
        let app: String
        let multiple: Bool
        let done: (@Sendable (String) -> Void)
        init(app: String, multiple: Bool, done: @escaping @Sendable (String) -> Void) {
            self.app = app
            self.multiple = multiple
            self.done = done
        }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            // Kept alive only while the picker is up: the rest runs on captured values.
            let app = self.app
            let multiple = self.multiple
            let done = self.done
            FileService.release(self)
            guard !results.isEmpty else { return done(Services.error("Cancelled")) }
            var images: [UIImage?] = Array(repeating: nil, count: results.count)
            let group = DispatchGroup()
            for (i, result) in results.enumerated() {
                group.enter()
                result.itemProvider.loadObject(ofClass: UIImage.self) { object, _ in
                    images[i] = object as? UIImage
                    group.leave()
                }
            }
            group.notify(queue: .main) {
                let picked = images.compactMap { $0 }
                var handles: [[String: Any]] = []
                for (i, image) in picked.enumerated() {
                    guard let data = FileStore.downscaledJPEG(image) else { continue }
                    handles.append(FileStore.write(app: app, name: picked.count > 1 ? "photo-\(i + 1).jpg" : "photo.jpg", type: "image/jpeg", data: data))
                }
                guard !handles.isEmpty else { return done(Services.error("Couldn't read the photo")) }
                done(Services.result(multiple ? handles : handles[0]))
            }
        }
    }

    // MARK: - takePhoto

    static func takePhoto(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let vc = viewController(done: done) else { return }
        guard let app = args["app"] as? String, !app.isEmpty else { return done(Services.error("A photo needs an app")) }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { return done(Services.error("This device has no camera")) }
        Task { @MainActor in
            let granted: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                granted = true
            case .notDetermined:
                granted = await AVCaptureDevice.requestAccess(for: .video)
            default:
                granted = false
            }
            guard granted else { return done(Services.error("Camera access is off for Jig in Settings")) }
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            let coordinator = CameraCoordinator(app: app, done: done)
            picker.delegate = coordinator
            retain(coordinator)
            vc.present(picker, animated: true)
        }
    }

    private final class CameraCoordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let app: String
        let done: (@Sendable (String) -> Void)
        init(app: String, done: @escaping @Sendable (String) -> Void) {
            self.app = app
            self.done = done
        }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            picker.dismiss(animated: true)
            guard let image = info[.originalImage] as? UIImage, let data = FileStore.downscaledJPEG(image) else {
                return finish(error: "Couldn't read the photo")
            }
            finish(result: FileStore.write(app: app, name: "photo.jpg", type: "image/jpeg", data: data))
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            finish(error: "Cancelled")
        }
        private func finish(result: Any? = nil, error: String? = nil) {
            FileService.release(self)
            if let error { done(Services.error(error)) } else { done(Services.result(result!)) }
        }
    }

    // MARK: - share

    static func share(_ args: [String: Any], done: @escaping @Sendable (String) -> Void) {
        guard let vc = viewController(done: done) else { return }
        var items: [Any] = []
        var tempShare: URL?
        if let text = args["text"] as? String, !text.isEmpty { items.append(text) }
        if let raw = args["url"] as? String, let url = URL(string: raw) { items.append(url) }
        if let id = args["file"] as? String, let app = args["app"] as? String, let url = FileStore.shareCopy(app: app, id: id) {
            tempShare = url
            items.append(url)
        }
        guard !items.isEmpty else { return done(Services.error("Nothing to share")) }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = vc.view
            popover.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
        }
        // Answered once the sheet is dismissed, shared or not; the temporary copy goes away with it.
        sheet.completionWithItemsHandler = { _, _, _, _ in
            if let tempShare { try? FileManager.default.removeItem(at: tempShare.deletingLastPathComponent()) }
            done(Services.result([:]))
        }
        vc.present(sheet, animated: true)
    }
}
