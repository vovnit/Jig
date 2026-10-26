import Foundation
import SQLite3

/// The SQLite database behind the runtime's `Database` contract (`core/src/bridge.ts`).
/// The schema lives in the runtime; this only runs SQL. Used from the JS queue only.
///
/// Requests and results cross the bridge as JSON, which keeps numbers, strings and
/// nulls intact: every call returns `{"rows": [...]}` or `{"error": "..."}`.
nonisolated final class SQLiteDatabase {
    private var db: OpaquePointer?
    private var statements: [String: OpaquePointer] = [:]
    private var openError: String?

    init(url: URL) {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            openError = error.localizedDescription
            return
        }
        if sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) != SQLITE_OK {
            openError = message()
            sqlite3_close(db)
            db = nil
            return
        }
        sqlite3_exec(db, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;", nil, nil, nil)
    }

    deinit {
        for statement in statements.values { sqlite3_finalize(statement) }
        sqlite3_close(db)
    }

    /// The device's database, shared by every app.
    static func standard() -> SQLiteDatabase {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return SQLiteDatabase(url: dir.appendingPathComponent("Jig/jig.sqlite"))
    }

    /// Runs one read. `paramsJSON` is a JSON array of values.
    func query(_ sql: String, paramsJSON: String) -> String {
        respond {
            let statement = try prepare(sql, params: decode(paramsJSON) as? [Any] ?? [])
            defer { sqlite3_reset(statement) }
            var rows: [[String: Any]] = []
            while true {
                let rc = sqlite3_step(statement)
                if rc == SQLITE_DONE { break }
                guard rc == SQLITE_ROW else { throw SQLiteError(message()) }
                var row: [String: Any] = [:]
                for i in 0..<sqlite3_column_count(statement) {
                    row[String(cString: sqlite3_column_name(statement, i))] = column(statement, i)
                }
                rows.append(row)
            }
            return rows
        }
    }

    /// Runs `[[sql, params?], ...]` in one transaction; on error nothing is written.
    func exec(_ statementsJSON: String) -> String {
        respond {
            let list = try decode(statementsJSON) as? [[Any]] ?? []
            try run("BEGIN")
            do {
                for entry in list {
                    guard let sql = entry.first as? String else { continue }
                    let statement = try prepare(sql, params: entry.count > 1 ? entry[1] as? [Any] ?? [] : [])
                    let rc = sqlite3_step(statement)
                    sqlite3_reset(statement)
                    guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw SQLiteError(message()) }
                }
                try run("COMMIT")
            } catch {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
                throw error
            }
            return []
        }
    }

    // MARK: - Helpers

    private struct SQLiteError: Error {
        let message: String
        init(_ message: String) { self.message = message }
    }

    private func respond(_ body: () throws -> [[String: Any]]) -> String {
        let result: [String: Any]
        do {
            guard db != nil else { throw SQLiteError(openError ?? "Database is not open") }
            result = ["rows": try body()]
        } catch let error as SQLiteError {
            result = ["error": error.message]
        } catch {
            result = ["error": error.localizedDescription]
        }
        let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data(#"{"error":"Unencodable result"}"#.utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private func decode(_ json: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])
    }

    private func run(_ sql: String) throws {
        if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK { throw SQLiteError(message()) }
    }

    /// Prepared statements are cached by SQL text; the runtime reuses a handful of them.
    private func prepare(_ sql: String, params: [Any]) throws -> OpaquePointer {
        let statement: OpaquePointer
        if let cached = statements[sql] {
            statement = cached
            sqlite3_clear_bindings(statement)
        } else {
            var prepared: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else { throw SQLiteError(message()) }
            statements[sql] = prepared
            statement = prepared
        }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, value) in params.enumerated() {
            let index = Int32(i + 1)
            switch value {
            case let s as String:
                sqlite3_bind_text(statement, index, s, -1, transient)
            case let n as NSNumber where CFNumberIsFloatType(n):
                sqlite3_bind_double(statement, index, n.doubleValue)
            case let n as NSNumber:
                sqlite3_bind_int64(statement, index, n.int64Value)
            default:
                sqlite3_bind_null(statement, index)
            }
        }
        return statement
    }

    private func column(_ statement: OpaquePointer, _ i: Int32) -> Any {
        switch sqlite3_column_type(statement, i) {
        case SQLITE_INTEGER: return sqlite3_column_int64(statement, i)
        case SQLITE_FLOAT: return sqlite3_column_double(statement, i)
        case SQLITE_TEXT: return String(cString: sqlite3_column_text(statement, i))
        default: return NSNull()
        }
    }

    private func message() -> String {
        db.map { String(cString: sqlite3_errmsg($0)) } ?? "Cannot open database"
    }
}
