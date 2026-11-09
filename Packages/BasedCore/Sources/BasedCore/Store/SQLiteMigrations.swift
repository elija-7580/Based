import Foundation
#if canImport(SQLite3)
import SQLite3
#else
import CSQLite
#endif

/// Numbered schema migrations for `based.sqlite` (BSD-23).
///
/// The database's format version lives in `PRAGMA user_version` (0 = a file from before this list existed).
/// On open, every migration with a higher version runs in order, each in its own transaction that also sets
/// `user_version`. Before the first migration of an existing file, a consistent copy is written next to it
/// (`based.sqlite.bak-v<old>`, via `VACUUM INTO`); only the newest such backup is kept. A file with a higher
/// version than this app knows is refused (`PersistenceError.newerFormat`) instead of being written.
///
/// Rules for new migrations: append, never edit or reorder; never drop user data (move it to `quarantine`);
/// every migration needs a test that opens a file of the previous version.
///
/// `meta` keys written here: `migration.backup` (path of the last backup), `migration.log` (last run, text).
struct SQLiteMigration {
    let version: Int
    let name: String
    let apply: (SQLitePersistence) throws -> Void
}

extension SQLitePersistence {
    static let migrations: [SQLiteMigration] = [
        SQLiteMigration(version: 1, name: "records, meta and the sync v2 change log") { db in
            try db.exec("""
            CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(kind, id));
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
            """)
            // Sync v2 change log. Existing records are entered as local changes so a first v2 push uploads them
            // and a server can serve them from sequence 0.
            guard !db.tableExists("changes") else { return }
            try db.exec("""
            CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                                  deleted INTEGER NOT NULL DEFAULT 0, local INTEGER NOT NULL DEFAULT 1);
            CREATE UNIQUE INDEX changes_key ON changes(kind, id);
            INSERT INTO changes(kind, id, deleted, local) SELECT kind, id, 0, 1 FROM records ORDER BY kind, id;
            """)
        },
        SQLiteMigration(version: 2, name: "quarantine table, one workspace record") { db in
            try db.exec("""
            CREATE TABLE IF NOT EXISTS quarantine (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL,
                                                   reason TEXT NOT NULL, at REAL NOT NULL);
            """)
            try db.dedupeWorkspaceRows()
        },
    ]

    static var currentSchemaVersion: Int { migrations.last?.version ?? 0 }

    /// The file's `PRAGMA user_version`.
    var schemaVersion: Int {
        guard let st = try? prepare("PRAGMA user_version") else { return 0 }
        defer { sqlite3_finalize(st) }
        return sqlite3_step(st) == SQLITE_ROW ? Int(sqlite3_column_int(st, 0)) : 0
    }

    /// First column of the first row as an integer (diagnostics, tests).
    func scalarInt(_ sql: String) -> Int? {
        guard let st = try? prepare(sql) else { return nil }
        defer { sqlite3_finalize(st) }
        return sqlite3_step(st) == SQLITE_ROW ? Int(sqlite3_column_int64(st, 0)) : nil
    }

    func tableExists(_ name: String) -> Bool {
        guard let st = try? prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?") else { return false }
        defer { sqlite3_finalize(st) }
        sqlite3_bind_text(st, 1, name, -1, SQLITE_TRANSIENT_PTR)
        return sqlite3_step(st) == SQLITE_ROW
    }

    /// Brings the file to `currentSchemaVersion`. Throws `newerFormat` without touching a newer file.
    func migrate() throws {
        let from = schemaVersion
        let target = Self.currentSchemaVersion
        if from > target { throw PersistenceError.newerFormat(found: from, supported: target) }
        guard from < target else { return }
        // Back up existing content (a file from before the list has user_version 0 but already has tables).
        var backupPath: String?
        if let url, tableExists("records") { backupPath = try backup(of: url, version: from) }
        for m in Self.migrations where m.version > from {
            try exec("BEGIN IMMEDIATE")
            do {
                try m.apply(self)
                try exec("PRAGMA user_version = \(m.version)")
                try exec("COMMIT")
            } catch {
                try? exec("ROLLBACK")
                throw PersistenceError.sqlite("migration \(m.version) (\(m.name)) failed: \(error)")
            }
            Log.info("based.sqlite migrated to v\(m.version): \(m.name)", category: "store")
        }
        if let backupPath { setMeta("migration.backup", Data(backupPath.utf8)) }
        setMeta("migration.log", Data("v\(from) → v\(target) at \(ISO8601DateFormatter().string(from: Date()))".utf8))
    }

    /// Writes `<file>.bak-v<version>` (a consistent copy, WAL included) and removes older `.bak-v*` files.
    private func backup(of url: URL, version: Int) throws -> String {
        let fm = FileManager.default
        let target = url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + ".bak-v\(version)")
        try? fm.removeItem(at: target)
        let escaped = target.path.replacingOccurrences(of: "'", with: "''")
        try exec("VACUUM INTO '\(escaped)'")
        let prefix = url.lastPathComponent + ".bak-v"
        let siblings = (try? fm.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)) ?? []
        for name in siblings where name.hasPrefix(prefix) && name != target.lastPathComponent {
            try? fm.removeItem(at: url.deletingLastPathComponent().appendingPathComponent(name))
        }
        return target.path
    }

    /// Several `workspace` rows (older archive imports, a foreign workspace from sync): keep the one with the
    /// newest stamp (decodable rows first, then `Workspace.mainID`), move the others to `quarantine`.
    func dedupeWorkspaceRows() throws {
        let st = try prepare("SELECT id, data FROM records WHERE kind = 'workspace'")
        var rows: [(id: String, data: Data, stamp: Stamp?)] = []
        struct Stamped: Decodable { var stamp: Stamp }
        while sqlite3_step(st) == SQLITE_ROW {
            let id = sqlite3_column_text(st, 0).map { String(cString: $0) } ?? ""
            let n = Int(sqlite3_column_bytes(st, 1))
            let data = sqlite3_column_blob(st, 1).map { Data(bytes: $0, count: n) } ?? Data()
            rows.append((id, data, try? JSONDecoder().decode(Stamped.self, from: data).stamp))
        }
        sqlite3_finalize(st)
        guard rows.count > 1 else { return }
        let keep = rows.max { a, b in
            if (a.stamp != nil) != (b.stamp != nil) { return a.stamp == nil }
            if let x = a.stamp, let y = b.stamp, x != y { return x < y }
            if (a.id == Workspace.mainID) != (b.id == Workspace.mainID) { return a.id != Workspace.mainID }
            return a.id > b.id
        }!
        for r in rows where r.id != keep.id {
            try quarantineRow(RecordKey(.workspace, r.id), data: r.data, reason: "duplicate workspace record (kept \(keep.id))")
        }
    }

    /// Moves a `records` row into `quarantine` (and drops its change-log entry, so it isn't synced).
    func quarantineRow(_ key: RecordKey, data: Data, reason: String) throws {
        try insertQuarantine(key, data: data, reason: reason)
        for sql in ["DELETE FROM records WHERE kind = ? AND id = ?", "DELETE FROM changes WHERE kind = ? AND id = ?"] {
            let d = try prepare(sql)
            defer { sqlite3_finalize(d) }
            sqlite3_bind_text(d, 1, key.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
            sqlite3_bind_text(d, 2, key.id, -1, SQLITE_TRANSIENT_PTR)
            guard sqlite3_step(d) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
        }
    }

    /// Copies a row that is about to be replaced (e.g. an undecodable workspace record) into `quarantine`,
    /// leaving `records` as it is. No-op if the row doesn't exist.
    public func preserveInQuarantine(_ key: RecordKey, reason: String) throws {
        guard let data = rawRow(key) else { return }
        try insertQuarantine(key, data: data, reason: reason)
    }

    private func insertQuarantine(_ key: RecordKey, data: Data, reason: String) throws {
        let q = try prepare("INSERT INTO quarantine(kind, id, data, reason, at) VALUES(?, ?, ?, ?, ?)")
        defer { sqlite3_finalize(q) }
        sqlite3_bind_text(q, 1, key.kind.rawValue, -1, SQLITE_TRANSIENT_PTR)
        sqlite3_bind_text(q, 2, key.id, -1, SQLITE_TRANSIENT_PTR)
        _ = data.withUnsafeBytes { sqlite3_bind_blob(q, 3, $0.baseAddress, Int32($0.count), SQLITE_TRANSIENT_PTR) }
        sqlite3_bind_text(q, 4, reason, -1, SQLITE_TRANSIENT_PTR)
        sqlite3_bind_double(q, 5, Date().timeIntervalSince1970)
        guard sqlite3_step(q) == SQLITE_DONE else { throw PersistenceError.sqlite(lastMessage) }
    }

    /// Rows in `quarantine` (diagnostics, tests).
    public func quarantinedKeys() -> [(key: RecordKey, reason: String)] {
        guard tableExists("quarantine"), let st = try? prepare("SELECT kind, id, reason FROM quarantine ORDER BY at") else { return [] }
        defer { sqlite3_finalize(st) }
        var out: [(RecordKey, String)] = []
        while sqlite3_step(st) == SQLITE_ROW {
            guard let k = sqlite3_column_text(st, 0), let kind = RecordKind(rawValue: String(cString: k)),
                  let i = sqlite3_column_text(st, 1) else { continue }
            out.append((RecordKey(kind, String(cString: i)), sqlite3_column_text(st, 2).map { String(cString: $0) } ?? ""))
        }
        return out
    }

    /// Test hook: runs raw SQL on a database file without migrating it (to build old-format fixtures).
    static func rawExec(path: String, _ sql: String) throws {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
            throw PersistenceError.sqlite("cannot open \(path)")
        }
        defer { sqlite3_close(db) }
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw PersistenceError.sqlite(msg)
        }
    }
}
