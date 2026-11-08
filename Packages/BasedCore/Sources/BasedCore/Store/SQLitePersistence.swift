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
public final class SQLitePersistence: ChangeLogging {
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
        try migrateChangeLog()
    }

    /// Sync v2 change log. Created once; existing records are entered as local changes so a first v2 push
    /// uploads them and a server can serve them from sequence 0.
    private func migrateChangeLog() throws {
        let exists: Bool = {
            guard let st = try? prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='changes'") else { return false }
            defer { sqlite3_finalize(st) }
            return sqlite3_step(st) == SQLITE_ROW
        }()
        guard !exists else { return }
        try exec("""
        BEGIN IMMEDIATE;
        CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                              deleted INTEGER NOT NULL DEFAULT 0, local INTEGER NOT NULL DEFAULT 1);
        CREATE UNIQUE INDEX changes_key ON changes(kind, id);
        INSERT INTO changes(kind, id, deleted, local) SELECT kind, id, 0, 1 FROM records ORDER BY kind, id;
        COMMIT;
        """)
    }

    deinit { sqlite3_close(db) }

    /// SQLite opened the file read-only (e.g. no write permission): every write would fail.
    public var isReadOnly: Bool { db.map { sqlite3_db_readonly($0, "main") == 1 } ?? true }

    /// Writes a probe value into `meta` inside a transaction; throws if the database can't be written.
    public func checkWritable() throws {
        if isReadOnly { throw PersistenceError.sqlite("database is read-only: \(url?.path ?? ":memory:")") }
        try exec("BEGIN IMMEDIATE")
        do {
            try exec("INSERT OR REPLACE INTO meta(key, value) VALUES('write.probe', CAST(strftime('%s','now') AS BLOB))")
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

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
        // Read the raw rows first (SQLite is single-threaded here), then decode the JSON on all cores:
        // decoding is ~85 % of the load time for big workspaces and every record decodes independently.
        let stmt = try prepare("SELECT kind, data FROM records")
        defer { sqlite3_finalize(stmt) }
        var raw: [(RecordKind, Data)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let k = sqlite3_column_text(stmt, 0), let kind = RecordKind(rawValue: String(cString: k)) else { continue }
            let n = Int(sqlite3_column_bytes(stmt, 1))
            guard let p = sqlite3_column_blob(stmt, 1) else { continue }
            raw.append((kind, Data(bytes: p, count: n)))
        }
        return Self.decodeParallel(raw)
    }

    /// Decodes rows in parallel chunks, keeping their order; undecodable rows are skipped (as before).
    static func decodeParallel(_ raw: [(RecordKind, Data)]) -> [Record] {
        let count = raw.count
        guard count > 2_000 else { return raw.compactMap { try? Record.decode(kind: $0.0, data: $0.1) } }
        let chunks = max(1, min(ProcessInfo.processInfo.activeProcessorCount * 2, count / 1_000))
        let size = (count + chunks - 1) / chunks
        let results = UnsafeMutableBufferPointer<[Record]>.allocate(capacity: chunks)
        results.initialize(repeating: [])
        defer { results.deinitialize(); results.deallocate() }
        let box = UnsafeSendableBuffer(results)
        DispatchQueue.concurrentPerform(iterations: chunks) { c in
            let lo = c * size, hi = min(count, lo + size)
            guard lo < hi else { return }
            var out: [Record] = []
            out.reserveCapacity(hi - lo)
            for i in lo..<hi { if let r = try? Record.decode(kind: raw[i].0, data: raw[i].1) { out.append(r) } }
            box.buffer[c] = out
        }
        return Array(results.joined())
    }

    public func write(upserts: [Record], deletions: [RecordKey]) throws {
        try write(upserts: upserts, deletions: deletions, local: true)
    }

    public func write(upserts: [Record], deletions: [RecordKey], local: Bool) throws {
        try exec("BEGIN IMMEDIATE")
        do {
            let ins = try prepare("INSERT OR REPLACE INTO records(kind, id, data) VALUES(?, ?, ?)")
            defer { sqlite3_finalize(ins) }
            // A record keeps one log row: its newest change (delete + insert gives it a new, higher seq).
            let unlog = try prepare("DELETE FROM changes WHERE kind = ? AND id = ?")
            defer { sqlite3_finalize(unlog) }
            let log = try prepare("INSERT INTO changes(kind, id, deleted, local) VALUES(?, ?, ?, ?)")
            defer { sqlite3_finalize(log) }
            func logChange(_ k: RecordKey, deleted: Bool) throws {
                sqlite3_reset(unlog)
                sqlite3_bind_text(unlog, 1, k.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
                sqlite3_bind_text(unlog, 2, k.id, -1, SQLITE_TRANSIENT_PTR)
                guard sqlite3_step(unlog) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
                sqlite3_reset(log)
                sqlite3_bind_text(log, 1, k.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
                sqlite3_bind_text(log, 2, k.id, -1, SQLITE_TRANSIENT_PTR)
                sqlite3_bind_int(log, 3, deleted ? 1 : 0)
                sqlite3_bind_int(log, 4, local ? 1 : 0)
                guard sqlite3_step(log) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
            }
            for r in upserts {
                let data = try r.encoded()
                sqlite3_reset(ins)
                sqlite3_bind_text(ins, 1, r.key.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
                sqlite3_bind_text(ins, 2, r.key.id, -1, SQLITE_TRANSIENT_PTR)
                _ = data.withUnsafeBytes { sqlite3_bind_blob(ins, 3, $0.baseAddress, Int32($0.count), SQLITE_TRANSIENT_PTR) }
                guard sqlite3_step(ins) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
                try logChange(r.key, deleted: false)
            }
            let del = try prepare("DELETE FROM records WHERE kind = ? AND id = ?")
            defer { sqlite3_finalize(del) }
            for k in deletions {
                sqlite3_reset(del)
                sqlite3_bind_text(del, 1, k.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
                sqlite3_bind_text(del, 2, k.id, -1, SQLITE_TRANSIENT_PTR)
                guard sqlite3_step(del) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
                try logChange(k, deleted: true)
            }
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    public func changes(after: Int64, limit: Int) throws -> [ChangeEntry] {
        let st = try prepare("SELECT seq, kind, id, deleted, local FROM changes WHERE seq > ? ORDER BY seq LIMIT ?")
        defer { sqlite3_finalize(st) }
        sqlite3_bind_int64(st, 1, after)
        sqlite3_bind_int64(st, 2, Int64(limit))
        var out: [ChangeEntry] = []
        while sqlite3_step(st) == SQLITE_ROW {
            guard let k = sqlite3_column_text(st, 1), let kind = RecordKind(rawValue: String(cString: k)),
                  let i = sqlite3_column_text(st, 2) else { continue }
            out.append(ChangeEntry(seq: sqlite3_column_int64(st, 0), key: RecordKey(kind, String(cString: i)),
                                   deleted: sqlite3_column_int(st, 3) != 0, local: sqlite3_column_int(st, 4) != 0))
        }
        return out
    }

    public var lastChangeSeq: Int64 {
        guard let st = try? prepare("SELECT COALESCE(MAX(seq), 0) FROM changes") else { return 0 }
        defer { sqlite3_finalize(st) }
        return sqlite3_step(st) == SQLITE_ROW ? sqlite3_column_int64(st, 0) : 0
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
public final class MemoryPersistence: ChangeLogging {
    public private(set) var records: [RecordKey: Record] = [:]
    public private(set) var metaValues: [String: Data] = [:]
    public private(set) var writes = 0
    private var log: [RecordKey: ChangeEntry] = [:]
    private var seq: Int64 = 0
    public init(_ initial: [Record] = []) {
        for r in initial { records[r.key] = r; seq += 1; log[r.key] = ChangeEntry(seq: seq, key: r.key, deleted: false, local: true) }
    }
    public func loadAll() throws -> [Record] { Array(records.values) }
    public func write(upserts: [Record], deletions: [RecordKey]) throws { try write(upserts: upserts, deletions: deletions, local: true) }
    public func write(upserts: [Record], deletions: [RecordKey], local: Bool) throws {
        writes += 1
        for r in upserts { records[r.key] = r; seq += 1; log[r.key] = ChangeEntry(seq: seq, key: r.key, deleted: false, local: local) }
        for k in deletions { records[k] = nil; seq += 1; log[k] = ChangeEntry(seq: seq, key: k, deleted: true, local: local) }
    }
    public func changes(after: Int64, limit: Int) throws -> [ChangeEntry] {
        Array(log.values.filter { $0.seq > after }.sorted { $0.seq < $1.seq }.prefix(limit))
    }
    public var lastChangeSeq: Int64 { seq }
    public func meta(_ key: String) -> Data? { metaValues[key] }
    public func setMeta(_ key: String, _ value: Data?) { metaValues[key] = value }
}
/// Lets `concurrentPerform` workers write their own slot of a buffer (each index written by one worker).
struct UnsafeSendableBuffer<T>: @unchecked Sendable {
    let buffer: UnsafeMutableBufferPointer<T>
    init(_ b: UnsafeMutableBufferPointer<T>) { buffer = b }
}
