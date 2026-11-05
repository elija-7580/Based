import Foundation
#if canImport(SQLite3)
import SQLite3
#else
import CSQLite
#endif

public enum PersistenceError: Error, CustomStringConvertible {
    case sqlite(String)
    public var description: String { if case .sqlite(let m) = self { return "SQLite: \(m)" }; return "" }
}

private let SQLITE_TRANSIENT_PTR = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Local database: one row per record (JSON payload) plus a key/value meta table.
public final class SQLitePersistence: Persistence {
    private var db: OpaquePointer?
    public let url: URL?

    /// `url == nil` opens an in-memory database (tests, previews).
    public init(url: URL?) throws {
        self.url = url
        let path = url?.path ?? ":memory:"
        if let url { try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) }
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw PersistenceError.sqlite("cannot open \(path)")
        }
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA synchronous=NORMAL;")
        try exec("""
        CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(kind, id));
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
        """)
    }

    deinit { sqlite3_close(db) }

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw PersistenceError.sqlite(msg)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw PersistenceError.sqlite(lastMessage) }
        return stmt
    }

    private var lastMessage: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "closed" }

    public func loadAll() throws -> [Record] {
        let stmt = try prepare("SELECT kind, data FROM records")
        defer { sqlite3_finalize(stmt) }
        var out: [Record] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let k = sqlite3_column_text(stmt, 0), let kind = RecordKind(rawValue: String(cString: k)) else { continue }
            let n = Int(sqlite3_column_bytes(stmt, 1))
            guard let p = sqlite3_column_blob(stmt, 1) else { continue }
            let data = Data(bytes: p, count: n)
            if let r = try? Record.decode(kind: kind, data: data) { out.append(r) }
        }
        return out
    }

    public func write(upserts: [Record], deletions: [RecordKey]) throws {
        try exec("BEGIN IMMEDIATE")
        do {
            let ins = try prepare("INSERT OR REPLACE INTO records(kind, id, data) VALUES(?, ?, ?)")
            defer { sqlite3_finalize(ins) }
            for r in upserts {
                let data = try r.encoded()
                sqlite3_reset(ins)
                sqlite3_bind_text(ins, 1, r.key.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
                sqlite3_bind_text(ins, 2, r.key.id, -1, SQLITE_TRANSIENT_PTR)
                _ = data.withUnsafeBytes { sqlite3_bind_blob(ins, 3, $0.baseAddress, Int32($0.count), SQLITE_TRANSIENT_PTR) }
                guard sqlite3_step(ins) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
            }
            let del = try prepare("DELETE FROM records WHERE kind = ? AND id = ?")
            defer { sqlite3_finalize(del) }
            for k in deletions {
                sqlite3_reset(del)
                sqlite3_bind_text(del, 1, k.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
                sqlite3_bind_text(del, 2, k.id, -1, SQLITE_TRANSIENT_PTR)
                guard sqlite3_step(del) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
            }
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    public func meta(_ key: String) -> Data? {
        guard let stmt = try? prepare("SELECT value FROM meta WHERE key = ?") else { return nil }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT_PTR)
        guard sqlite3_step(stmt) == SQLITE_ROW, let p = sqlite3_column_blob(stmt, 0) else { return nil }
        return Data(bytes: p, count: Int(sqlite3_column_bytes(stmt, 0)))
    }

    public func setMeta(_ key: String, _ value: Data?) {
        if let value {
            guard let stmt = try? prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)") else { return }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT_PTR)
            _ = value.withUnsafeBytes { sqlite3_bind_blob(stmt, 2, $0.baseAddress, Int32($0.count), SQLITE_TRANSIENT_PTR) }
            _ = sqlite3_step(stmt)
        } else {
            guard let stmt = try? prepare("DELETE FROM meta WHERE key = ?") else { return }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT_PTR)
            _ = sqlite3_step(stmt)
        }
    }

    /// Meta keys with a prefix (e.g. CloudKit system fields "ck:").
    public func metaKeys(prefix: String) -> [String] {
        guard let stmt = try? prepare("SELECT key FROM meta WHERE key LIKE ? ESCAPE '\\'") else { return [] }
        defer { sqlite3_finalize(stmt) }
        let escaped = prefix.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_") + "%"
        sqlite3_bind_text(stmt, 1, escaped, -1, SQLITE_TRANSIENT_PTR)
        var out: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW { if let t = sqlite3_column_text(stmt, 0) { out.append(String(cString: t)) } }
        return out
    }
}

/// In-memory persistence for previews and tests.
public final class MemoryPersistence: Persistence {
    public private(set) var records: [RecordKey: Record] = [:]
    public private(set) var metaValues: [String: Data] = [:]
    public private(set) var writes = 0
    public init(_ initial: [Record] = []) { for r in initial { records[r.key] = r } }
    public func loadAll() throws -> [Record] { Array(records.values) }
    public func write(upserts: [Record], deletions: [RecordKey]) throws {
        writes += 1
        for r in upserts { records[r.key] = r }
        for k in deletions { records[k] = nil }
    }
    public func meta(_ key: String) -> Data? { metaValues[key] }
    public func setMeta(_ key: String, _ value: Data?) { metaValues[key] = value }
}