import Foundation

/// Entries of zip archives (EPUBs are zips) for the Phase F book actions:
/// `zip.list {app, id}` and `zip.read {app, id, path, as}`. The bytes come only
/// from the Phase E `files.read` service, never from a file path; until that
/// service exists these answer its error. Stored and deflated entries; anything
/// else, or a broken archive, answers an error. The directory is cached per
/// (app, id), and outputs are capped so a corrupt archive can't blow memory.
nonisolated enum ZipArchive {
    struct Entry: Sendable {
        var path: String
        var method: Int
        var data: Int
        var compSize: Int
        var size: Int
    }

    private static let maxArchive = 64 * 1024 * 1024
    private static let maxEntry = 16 * 1024 * 1024
    private static let maxEntries = 5000

    /// Why an archive couldn't be read, as said to the app.
    struct Failure: Error, ExpressibleByStringLiteral {
        let message: String
        init(_ message: String) { self.message = message }
        init(stringLiteral message: String) { self.message = message }
    }

    private static let lock = NSLock()
    // Guarded by `lock`.
    nonisolated(unsafe) private static var cache: [String: (bytes: Data, entries: [Entry])] = [:]

    static func list(app: String, id: String, done: @escaping @Sendable (String) -> Void) {
        dir(app: app, id: id) { result in
            switch result {
            case let .success((_, entries)): done(Services.result(["entries": entries.map { ["path": $0.path, "size": $0.size] }]))
            case let .failure(failure): done(Services.error(failure.message))
            }
        }
    }

    static func read(app: String, id: String, path: String, as format: String, done: @escaping @Sendable (String) -> Void) {
        dir(app: app, id: id) { result in
            switch result {
            case let .success((bytes, entries)):
                guard let entry = entries.first(where: { $0.path == path }) else {
                    return done(Services.error("No '\(path)' in this file"))
                }
                guard let raw = inflate(bytes: bytes, entry: entry) else {
                    return done(Services.error("That file isn't a zip archive"))
                }
                done(Services.result(["data": format == "base64" ? raw.base64EncodedString() : String(decoding: raw, as: UTF8.self)]))
            case let .failure(failure):
                done(Services.error(failure.message))
            }
        }
    }

    private static func dir(app: String, id: String, done: @escaping @Sendable (Result<(Data, [Entry]), Failure>) -> Void) {
        let key = "\(app)\n\(id)"
        lock.lock()
        let hit = cache[key]
        lock.unlock()
        if let hit { return done(.success(hit)) }
        fileBytes(app: app, id: id) { result in
            switch result {
            case let .success(bytes):
                guard bytes.count <= maxArchive else { return done(.failure("That file is too big to open")) }
                guard let entries = parse(bytes: bytes) else { return done(.failure("That file isn't a zip archive")) }
                lock.lock()
                cache[key] = (bytes, entries)
                lock.unlock()
                done(.success((bytes, entries)))
            case let .failure(message):
                done(.failure(message))
            }
        }
    }

    /// The stored file's bytes through `files.read` (the whole file as base64).
    private static func fileBytes(app: String, id: String, done: @escaping @Sendable (Result<Data, Failure>) -> Void) {
        Services.handle("files.read", argsJSON: Services.encode(["app": app, "id": id, "as": "base64"]), done: { json in
            guard let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else {
                return done(.failure("Bad 'files.read' answer"))
            }
            if let data = (obj["result"] as? [String: Any])?["data"] as? String, let bytes = Data(base64Encoded: data) {
                done(.success(bytes))
            } else {
                done(.failure(Failure((obj["error"] as? String) ?? "No file")))
            }
        }, progress: { _ in })
    }

    /// The central directory: every entry's path, method and data offset, bounds-checked.
    private static func parse(bytes: Data) -> [Entry]? {
        guard bytes.count >= 22 else { return nil }
        // The end-of-central-directory record sits in the last 64K + 22 bytes.
        var eocd: Int? = nil
        var at = bytes.count - 22
        while at >= max(0, bytes.count - 65557) {
            if u32(bytes, at) == 0x06054B50 {
                eocd = at
                break
            }
            at -= 1
        }
        guard let eocd else { return nil }
        let count = Int(u16(bytes, eocd + 10))
        let cdSize = Int(u32(bytes, eocd + 12))
        let cdOff = Int(u32(bytes, eocd + 16))
        guard count <= maxEntries, cdOff + cdSize <= bytes.count else { return nil }
        var entries: [Entry] = []
        entries.reserveCapacity(min(count, 1024))
        at = cdOff
        for _ in 0 ..< count {
            guard at + 46 <= bytes.count, u32(bytes, at) == 0x02014B50 else { return nil }
            let flags = Int(u16(bytes, at + 8))
            let method = Int(u16(bytes, at + 10))
            let compSize = Int(u32(bytes, at + 20))
            let size = Int(u32(bytes, at + 24))
            let nameLen = Int(u16(bytes, at + 28))
            let extraLen = Int(u16(bytes, at + 30))
            let commentLen = Int(u16(bytes, at + 32))
            let localOff = Int(u32(bytes, at + 42))
            at += 46
            guard at + nameLen + extraLen + commentLen <= bytes.count else { return nil }
            guard let path = String(data: bytes.subdata(in: at ..< at + nameLen), encoding: .utf8) else { return nil }
            at += nameLen + extraLen + commentLen
            if path.hasSuffix("/") { continue } // a directory
            guard method == 0 || method == 8, flags & 0x01 == 0, flags & 0x08 == 0 else { return nil }
            guard compSize != 0xFFFF_FFFF, size != 0xFFFF_FFFF, size <= maxEntry else { return nil }
            // The local header repeats the shape; the data follows its name and extra fields.
            guard localOff + 30 <= bytes.count, u32(bytes, localOff) == 0x04034B50 else { return nil }
            let data = localOff + 30 + Int(u16(bytes, localOff + 26)) + Int(u16(bytes, localOff + 28))
            guard data + compSize <= bytes.count else { return nil }
            entries.append(Entry(path: path, method: method, data: data, compSize: compSize, size: size))
        }
        return entries
    }

    private static func inflate(bytes: Data, entry: Entry) -> Data? {
        let comp = bytes.subdata(in: entry.data ..< entry.data + entry.compSize)
        if entry.method == 0 {
            return comp.count == entry.size ? comp : nil
        }
        // Raw deflate, which zip uses.
        guard let raw = try? (comp as NSData).decompressed(using: .zlib), raw.length == entry.size else { return nil }
        return raw as Data
    }

    private static func u16(_ bytes: Data, _ at: Int) -> UInt16 {
        UInt16(bytes[at]) | (UInt16(bytes[at + 1]) << 8)
    }

    private static func u32(_ bytes: Data, _ at: Int) -> UInt32 {
        UInt32(bytes[at]) | (UInt32(bytes[at + 1]) << 8) | (UInt32(bytes[at + 2]) << 16) | (UInt32(bytes[at + 3]) << 24)
    }
}
