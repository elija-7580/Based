import Foundation
#if canImport(SQLite3)
import SQLite3
#else
import CSQLite
#endif

private let HISTORY_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Page version history, stored the way git stores a repository — content-addressed and deduplicated:
///
/// * **Objects**: every block is encoded once per distinct content and stored under the hash of that content
///   (`objects` table, compressed with zlib on Apple platforms). A block that didn't change between two
///   versions is one shared object, so a version of a 500-block page where one paragraph changed costs one
///   new block object plus one manifest.
/// * **Manifest** (git's tree): the page's blocks in document order as `id<TAB>hash` lines, itself an object.
///   Two versions with the same manifest hash are the same content — a snapshot that changes nothing is skipped.
/// * **Version** (git's commit): page, time, manifest hash, title and a few counts for the list.
///
/// It lives in its own SQLite file next to the workspace (`history.sqlite`), is never synced, and thins
/// out with age (`prune`): every version of the last day, one per hour for a week, one per day for three
/// months, one per week after that. Unreferenced objects are swept by `collectGarbage()`.
///
/// Thread-safe: all database work runs on a private serial queue; the app hands over `[Block]` value copies.
public final class VersionHistory: @unchecked Sendable {
    public struct Version: Identifiable, Hashable, Sendable {
        public var id: Int64
        public var pageID: RecordID
        public var date: Date
        public var manifest: String
        public var title: String
        public var blockCount: Int
        public var wordCount: Int
        public var reason: String
    }

    public struct Stats: Sendable {
        public var versions: Int
        public var objects: Int
        public var bytes: Int64
    }

    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "based.history", qos: .utility)
    /// block id → (updatedAt, hash) of the last encoding, so unchanged blocks aren't re-encoded every snapshot.
    private var hashCache: [RecordID: (Date, String)] = [:]
    /// Hashes known to be stored (avoids an INSERT round trip per unchanged block).
    private var known: Set<String> = []

    public init(url: URL?) throws {
        let path = url?.path ?? ":memory:"
        if let url { try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) }
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw PersistenceError.sqlite("cannot open \(path)")
        }
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA synchronous=NORMAL;")
        try exec("""
        CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT NOT NULL, at REAL NOT NULL,
                                             manifest TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
                                             blocks INTEGER NOT NULL DEFAULT 0, words INTEGER NOT NULL DEFAULT 0,
                                             reason TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS versions_page ON versions(page, at);
        """)
    }

    deinit { sqlite3_close(db) }

    // MARK: Writing

    /// Records a version of `page` from its blocks (page block first, then its content in document order —
    /// see `WorkspaceStore.versionBlocks(of:)`). Returns nil when nothing changed since the page's last version.
    @discardableResult
    public func record(page: RecordID, blocks: [Block], title: String, reason: String = "edit", at date: Date = Date()) -> Version? {
        queue.sync { _record(page: page, blocks: blocks, title: title, reason: reason, at: date) }
    }

    /// Same as `record`, off the caller's thread.
    public func recordAsync(page: RecordID, blocks: [Block], title: String, reason: String = "edit", at date: Date = Date(),
                            completion: (@Sendable (Version?) -> Void)? = nil) {
        queue.async { [self] in completion?(_record(page: page, blocks: blocks, title: title, reason: reason, at: date)) }
    }

    private func _record(page: RecordID, blocks: [Block], title: String, reason: String, at date: Date) -> Version? {
        guard !blocks.isEmpty else { return nil }
        var lines: [String] = []
        lines.reserveCapacity(blocks.count)
        var words = 0
        try? exec("BEGIN IMMEDIATE;")
        for b in blocks {
            let hash: String
            if let (t, h) = hashCache[b.id], t == b.updatedAt, known.contains(h) {
                hash = h
            } else {
                guard let data = Self.encode(b) else { continue }
                hash = Self.hash(data)
                if !known.contains(hash) { put(hash, data); known.insert(hash) }
                hashCache[b.id] = (b.updatedAt, hash)
            }
            lines.append(b.id + "\t" + hash)
            if b.id != page { words += b.text.plainText.split { $0.isWhitespace || $0.isNewline }.count }
        }
        let manifestData = Data(lines.joined(separator: "\n").utf8)
        let manifest = Self.hash(manifestData)
        if _versions(page: page, limit: 1).first?.manifest == manifest { try? exec("COMMIT;"); return nil }
        if !known.contains(manifest) { put(manifest, manifestData); known.insert(manifest) }
        let st = try? prepare("INSERT INTO versions(page, at, manifest, title, blocks, words, reason) VALUES (?,?,?,?,?,?,?)")
        defer { sqlite3_finalize(st) }
        bind(st, 1, page); sqlite3_bind_double(st, 2, date.timeIntervalSince1970); bind(st, 3, manifest); bind(st, 4, title)
        sqlite3_bind_int64(st, 5, Int64(blocks.count - 1)); sqlite3_bind_int64(st, 6, Int64(words)); bind(st, 7, reason)
        sqlite3_step(st)
        let id = sqlite3_last_insert_rowid(db)
        try? exec("COMMIT;")
        return Version(id: id, pageID: page, date: date, manifest: manifest, title: title,
                       blockCount: blocks.count - 1, wordCount: words, reason: reason)
    }

    private func put(_ hash: String, _ data: Data) {
        let st = try? prepare("INSERT OR IGNORE INTO objects(hash, data) VALUES (?, ?)")
        defer { sqlite3_finalize(st) }
        bind(st, 1, hash)
        let stored = Self.compress(data)
        _ = stored.withUnsafeBytes { sqlite3_bind_blob(st, 2, $0.baseAddress, Int32($0.count), HISTORY_TRANSIENT) }
        sqlite3_step(st)
    }

    // MARK: Reading

    /// Versions of a page, newest first.
    public func versions(of page: RecordID, limit: Int = 500) -> [Version] {
        queue.sync { _versions(page: page, limit: limit) }
    }

    public func latest(of page: RecordID) -> Version? {
        queue.sync { _versions(page: page, limit: 1).first }
    }

    private func _versions(page: RecordID, limit: Int) -> [Version] {
        let st = try? prepare("SELECT id, at, manifest, title, blocks, words, reason FROM versions WHERE page = ? ORDER BY at DESC, id DESC LIMIT ?")
        defer { sqlite3_finalize(st) }
        bind(st, 1, page); sqlite3_bind_int64(st, 2, Int64(limit))
        var out: [Version] = []
        while sqlite3_step(st) == SQLITE_ROW {
            out.append(Version(id: sqlite3_column_int64(st, 0), pageID: page,
                               date: Date(timeIntervalSince1970: sqlite3_column_double(st, 1)),
                               manifest: text(st, 2), title: text(st, 3),
                               blockCount: Int(sqlite3_column_int64(st, 4)), wordCount: Int(sqlite3_column_int64(st, 5)),
                               reason: text(st, 6)))
        }
        return out
    }

    /// The blocks of a version: page block first, then the content in document order.
    public func blocks(of version: Version) -> [Block] {
        queue.sync {
            guard let m = object(version.manifest), let text = String(data: m, encoding: .utf8) else { return [] }
            return text.split(separator: "\n").compactMap { line -> Block? in
                let parts = line.split(separator: "\t", maxSplits: 1)
                guard parts.count == 2, let data = object(String(parts[1])) else { return nil }
                return try? JSONDecoder().decode(Block.self, from: data)
            }
        }
    }

    private func object(_ hash: String) -> Data? {
        let st = try? prepare("SELECT data FROM objects WHERE hash = ?")
        defer { sqlite3_finalize(st) }
        bind(st, 1, hash)
        guard sqlite3_step(st) == SQLITE_ROW, let p = sqlite3_column_blob(st, 0) else { return nil }
        return Self.decompress(Data(bytes: p, count: Int(sqlite3_column_bytes(st, 0))))
    }

    public func stats() -> Stats {
        queue.sync {
            func count(_ sql: String) -> Int64 {
                let st = try? prepare(sql); defer { sqlite3_finalize(st) }
                return sqlite3_step(st) == SQLITE_ROW ? sqlite3_column_int64(st, 0) : 0
            }
            return Stats(versions: Int(count("SELECT COUNT(*) FROM versions")),
                         objects: Int(count("SELECT COUNT(*) FROM objects")),
                         bytes: count("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM objects"))
        }
    }

    // MARK: Retention

    /// Thins out old versions: all of the last 24 h, the newest per hour for 7 days, per day for 90 days, per
    /// week beyond. Returns how many versions were removed. Call `collectGarbage()` afterwards.
    @discardableResult
    public func prune(now: Date = Date()) -> Int {
        queue.sync {
            let st = try? prepare("SELECT id, page, at FROM versions ORDER BY page, at DESC, id DESC")
            var seen = Set<String>()
            var drop: [Int64] = []
            while sqlite3_step(st) == SQLITE_ROW {
                let id = sqlite3_column_int64(st, 0), page = text(st, 1), at = sqlite3_column_double(st, 2)
                let age = now.timeIntervalSince1970 - at
                let bucket: String
                if age < 86_400 { continue }
                else if age < 7 * 86_400 { bucket = "h\(Int(at / 3600))" }
                else if age < 90 * 86_400 { bucket = "d\(Int(at / 86_400))" }
                else { bucket = "w\(Int(at / (7 * 86_400)))" }
                if !seen.insert(page + bucket).inserted { drop.append(id) }
            }
            sqlite3_finalize(st)
            guard !drop.isEmpty else { return 0 }
            try? exec("BEGIN IMMEDIATE;")
            for chunk in stride(from: 0, to: drop.count, by: 500) {
                let ids = drop[chunk..<min(drop.count, chunk + 500)].map(String.init).joined(separator: ",")
                try? exec("DELETE FROM versions WHERE id IN (\(ids));")
            }
            try? exec("COMMIT;")
            return drop.count
        }
    }

    /// Deletes objects no version refers to any more (mark from every manifest, sweep the rest).
    @discardableResult
    public func collectGarbage() -> Int {
        queue.sync {
            var live = Set<String>()
            let st = try? prepare("SELECT DISTINCT manifest FROM versions")
            var manifests: [String] = []
            while sqlite3_step(st) == SQLITE_ROW { manifests.append(text(st, 0)) }
            sqlite3_finalize(st)
            for m in manifests {
                live.insert(m)
                guard let d = object(m), let s = String(data: d, encoding: .utf8) else { continue }
                for line in s.split(separator: "\n") {
                    if let tab = line.firstIndex(of: "\t") { live.insert(String(line[line.index(after: tab)...])) }
                }
            }
            let all = try? prepare("SELECT hash FROM objects")
            var dead: [String] = []
            while sqlite3_step(all) == SQLITE_ROW { let h = text(all, 0); if !live.contains(h) { dead.append(h) } }
            sqlite3_finalize(all)
            guard !dead.isEmpty else { return 0 }
            try? exec("BEGIN IMMEDIATE;")
            let del = try? prepare("DELETE FROM objects WHERE hash = ?")
            for h in dead { sqlite3_reset(del); bind(del, 1, h); sqlite3_step(del) }
            sqlite3_finalize(del)
            try? exec("COMMIT;")
            known.subtract(dead)
            return dead.count
        }
    }

    /// Removes every version of a page (e.g. when it is deleted permanently).
    public func forget(page: RecordID) {
        queue.async { [self] in
            let st = try? prepare("DELETE FROM versions WHERE page = ?")
            bind(st, 1, page); sqlite3_step(st); sqlite3_finalize(st)
        }
    }

    // MARK: Encoding

    static func encode(_ b: Block) -> Data? {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        e.dateEncodingStrategy = .deferredToDate
        return try? e.encode(b)
    }

    /// 128-bit content hash (two independent 64-bit FNV-1a lanes with a final avalanche), hex. Not
    /// cryptographic — it only has to tell block contents apart, and must be available on every platform.
    static func hash(_ data: Data) -> String {
        var a: UInt64 = 0xcbf29ce484222325
        var b: UInt64 = 0x84222325cbf29ce4 ^ UInt64(data.count)
        data.withUnsafeBytes { raw in
            for byte in raw {
                a = (a ^ UInt64(byte)) &* 0x100000001b3
                b = (b ^ UInt64(byte)) &* 0x00000100000001b3 &+ 0x9E3779B97F4A7C15
            }
        }
        func mix(_ x: UInt64) -> UInt64 {
            var z = x
            z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
            z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
            return z ^ (z >> 31)
        }
        return String(format: "%016llx%016llx", mix(a), mix(b ^ a))
    }

    /// One flag byte (0 = raw, 1 = zlib) + payload.
    static func compress(_ data: Data) -> Data {
        #if canImport(Darwin)
        if data.count > 96, let z = try? (data as NSData).compressed(using: .zlib) as Data, z.count < data.count {
            return Data([1]) + z
        }
        #endif
        return Data([0]) + data
    }

    static func decompress(_ stored: Data) -> Data? {
        guard let flag = stored.first else { return nil }
        let body = stored.dropFirst()
        switch flag {
        case 0: return Data(body)
        case 1:
            #if canImport(Darwin)
            return try? (Data(body) as NSData).decompressed(using: .zlib) as Data
            #else
            return nil
            #endif
        default: return nil
        }
    }

    // MARK: SQLite helpers

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw PersistenceError.sqlite(msg)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else {
            throw PersistenceError.sqlite(db.map { String(cString: sqlite3_errmsg($0)) } ?? "closed")
        }
        return st
    }

    private func bind(_ st: OpaquePointer?, _ i: Int32, _ s: String) {
        sqlite3_bind_text(st, i, s, -1, HISTORY_TRANSIENT)
    }

    private func text(_ st: OpaquePointer?, _ i: Int32) -> String {
        sqlite3_column_text(st, i).map { String(cString: $0) } ?? ""
    }
}

// MARK: - Store side

extension WorkspaceStore {
    /// What a page version holds: the page block, then every block on the page in document order — nested
    /// blocks included, but not the content of sub-pages (they have their own history); a sub-page appears
    /// as its own block (title, icon), like a link. Trashed blocks are left out.
    public func versionBlocks(of page: RecordID) -> [Block] {
        guard let p = blocks[page] else { return [] }
        var out = [p]
        func walk(_ id: RecordID) {
            for c in children(of: .block(id)) {
                guard let b = blocks[c], b.trashedAt == nil else { continue }
                out.append(b)
                if !b.type.isPageLike { walk(c) }
            }
        }
        walk(page)
        return out
    }

    /// Puts a page back to a stored version, as one undoable step: blocks of the version come back as they
    /// were (text, properties, nesting, order), blocks added since are deleted. Sub-pages are never touched
    /// (they have their own history); one created since inside a block that goes away moves to the top level.
    public func restoreVersion(of page: RecordID, blocks version: [Block]) {
        guard let first = version.first, first.id == page, blocks[page] != nil else { return }
        let current = versionBlocks(of: page)
        let keep = Set(version.map(\.id))
        transact("Restore version") { tx in
            tx.update(page) { p in
                p.text = first.text
                p.props = first.props
                p.values = first.values
            }
            // Sub-pages have their own history: they are left where they are now.
            for b in version.dropFirst() where !b.type.isPageLike {
                var restored = b
                restored.trashedAt = nil
                tx.put(restored)
            }
            for b in current.dropFirst() where !keep.contains(b.id) {
                if b.type.isPageLike {
                    if case .block(let parent) = b.parent, parent != page, !keep.contains(parent) {
                        tx.update(b.id) { $0.parent = .block(page) }
                    }
                } else {
                    tx.removeBlock(b.id)
                }
            }
        }
    }
}
