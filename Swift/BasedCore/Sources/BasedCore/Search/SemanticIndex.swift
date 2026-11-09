import Foundation
#if canImport(SQLite3)
import SQLite3
#else
import CSQLite
#endif

private let SEMANTIC_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Turns text into vectors (BSD-62). The app uses Apple's on-device sentence embedding (`NLEmbedding`, offline,
/// no key); a server can use an OpenAI-compatible `/v1/embeddings` endpoint (e.g. Ollama); tests use a fake.
///
/// `id` names the model: vectors of different models can't be compared, so the index starts over when it changes.
public protocol EmbeddingProvider: Sendable {
    var id: String { get }
    var dimension: Int { get }
    /// One vector per text, each `dimension` long. Throwing (or returning a wrong count) skips the batch.
    func embed(_ texts: [String]) async throws -> [[Float]]
}

/// A page section found by meaning.
public struct SemanticHit: Hashable, Sendable {
    public var pageID: RecordID
    /// Cosine similarity, -1…1.
    public var score: Float
    /// The best-matching section of the page.
    public var snippet: String
    public init(pageID: RecordID, score: Float, snippet: String) {
        self.pageID = pageID
        self.score = score
        self.snippet = snippet
    }
}

/// Index plus the model that filled it — everything a caller needs for semantic search.
public struct SemanticContext: Sendable {
    public let index: SemanticIndex
    public let provider: any EmbeddingProvider
    public init(index: SemanticIndex, provider: any EmbeddingProvider) {
        self.index = index
        self.provider = provider
    }
}

/// Vector index over page sections (BSD-62).
///
/// * A page is cut into sections of about 800 characters along block boundaries (`WorkspaceStore.semanticChunks`);
///   each section is embedded once and stored with the hash of its text, so re-indexing a page only re-embeds
///   when its text changed (`SemanticIndexer`).
/// * Vectors are normalised on insert; a query is a brute-force dot product over all sections (Float32, a tight
///   loop) — fast enough for ~50k sections and needs no extra dependency.
/// * Persisted in its own SQLite file next to the workspace (`embeddings.sqlite`), never synced: it can always be
///   rebuilt from the pages. When the provider (`id`/`dimension`) changes, the stored vectors are dropped.
///
/// Thread-safe: everything runs on a private serial queue.
public final class SemanticIndex: @unchecked Sendable {
    struct Entry {
        var hash: String
        var text: String
        var vector: [Float]
    }

    public let providerID: String
    public let dimension: Int
    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "based.semantic", qos: .utility)
    private var pages: [RecordID: [Entry]] = [:]

    /// `url` nil keeps the index in memory only.
    public init(url: URL?, providerID: String, dimension: Int) throws {
        self.providerID = providerID
        self.dimension = dimension
        let path = url?.path ?? ":memory:"
        if let url { try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) }
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw PersistenceError.sqlite("cannot open \(path)")
        }
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA synchronous=NORMAL;")
        try exec("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS chunks (page TEXT NOT NULL, ord INTEGER NOT NULL, hash TEXT NOT NULL,
                                           text TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (page, ord)) WITHOUT ROWID;
        """)
        let model = "\(providerID)#\(dimension)"
        if metaValue("model") != model {
            try exec("DELETE FROM chunks;")
            setMeta("model", model)
        }
        load()
    }

    deinit { sqlite3_close(db) }

    // MARK: Reading

    /// Pages that have at least one section in the index.
    public var pageIDs: Set<RecordID> { queue.sync { Set(pages.keys) } }

    public var sectionCount: Int { queue.sync { pages.values.reduce(0) { $0 + $1.count } } }

    /// Hashes of a page's stored sections in order (empty when the page isn't indexed).
    public func hashes(of page: RecordID) -> [String] { queue.sync { pages[page]?.map(\.hash) ?? [] } }

    /// Pages closest to `vector`, best section per page, highest first.
    public func query(_ vector: [Float], limit: Int = 20, minScore: Float = -1, excluding: Set<RecordID> = []) -> [SemanticHit] {
        guard vector.count == dimension, let q = Self.normalized(vector) else { return [] }
        return queue.sync { rank(q, limit: limit, minScore: minScore, excluding: excluding) }
    }

    /// Pages similar to `page` as a whole (mean of its sections), without the page itself.
    public func related(to page: RecordID, limit: Int = 5, minScore: Float = -1, excluding: Set<RecordID> = []) -> [SemanticHit] {
        queue.sync {
            guard let entries = pages[page], !entries.isEmpty else { return [] }
            var mean = [Float](repeating: 0, count: dimension)
            for e in entries { for i in 0..<dimension { mean[i] += e.vector[i] } }
            guard let q = Self.normalized(mean) else { return [] }
            return rank(q, limit: limit, minScore: minScore, excluding: excluding.union([page]))
        }
    }

    private func rank(_ q: [Float], limit: Int, minScore: Float, excluding: Set<RecordID>) -> [SemanticHit] {
        var out: [SemanticHit] = []
        out.reserveCapacity(pages.count)
        q.withUnsafeBufferPointer { qp in
            for (page, entries) in pages where !excluding.contains(page) {
                var best: Float = -2
                var bestText = ""
                for e in entries {
                    let s = e.vector.withUnsafeBufferPointer { vp in Self.dot(qp, vp) }
                    if s > best { best = s; bestText = e.text }
                }
                if best >= minScore { out.append(SemanticHit(pageID: page, score: best, snippet: Self.snippet(bestText))) }
            }
        }
        out.sort { $0.score != $1.score ? $0.score > $1.score : $0.pageID < $1.pageID }
        return Array(out.prefix(max(0, limit)))
    }

    // MARK: Writing

    /// Replaces all sections of `page`. `texts`, `hashes` and `vectors` run in parallel; vectors of the wrong
    /// size are refused (the page is left as it was).
    @discardableResult
    public func replace(page: RecordID, texts: [String], hashes: [String], vectors: [[Float]]) -> Bool {
        guard texts.count == hashes.count, texts.count == vectors.count else { return false }
        var entries: [Entry] = []
        for i in texts.indices {
            guard vectors[i].count == dimension else { return false }
            // A text the model can't embed (zero vector) is kept so its hash counts as indexed; it never matches.
            let v = Self.normalized(vectors[i]) ?? [Float](repeating: 0, count: dimension)
            entries.append(Entry(hash: hashes[i], text: texts[i], vector: v))
        }
        queue.sync {
            try? exec("BEGIN IMMEDIATE;")
            deleteRows(page)
            for (i, e) in entries.enumerated() { insertRow(page, i, e) }
            try? exec("COMMIT;")
            if entries.isEmpty { pages[page] = nil } else { pages[page] = entries }
        }
        return true
    }

    public func remove(page: RecordID) {
        queue.sync {
            deleteRows(page)
            pages[page] = nil
        }
    }

    /// Empties the index (Settings → rebuild).
    public func removeAll() {
        queue.sync {
            try? exec("DELETE FROM chunks;")
            pages = [:]
        }
    }

    // MARK: Math

    static func dot(_ a: UnsafeBufferPointer<Float>, _ b: UnsafeBufferPointer<Float>) -> Float {
        let n = min(a.count, b.count)
        var s0: Float = 0, s1: Float = 0, s2: Float = 0, s3: Float = 0
        var i = 0
        while i + 4 <= n {
            s0 += a[i] * b[i]; s1 += a[i + 1] * b[i + 1]; s2 += a[i + 2] * b[i + 2]; s3 += a[i + 3] * b[i + 3]
            i += 4
        }
        while i < n { s0 += a[i] * b[i]; i += 1 }
        return (s0 + s1) + (s2 + s3)
    }

    /// Unit-length copy; nil for a zero (or non-finite) vector.
    static func normalized(_ v: [Float]) -> [Float]? {
        var sum: Float = 0
        for x in v { sum += x * x }
        guard sum > 0, sum.isFinite else { return nil }
        let inv = 1 / sum.squareRoot()
        return v.map { $0 * inv }
    }

    static func snippet(_ text: String) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        return flat.count > 160 ? String(flat.prefix(160)) + "…" : flat
    }

    // MARK: SQLite

    private func load() {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT page, hash, text, vec FROM chunks ORDER BY page, ord;", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            let page = String(cString: sqlite3_column_text(stmt, 0))
            let hash = String(cString: sqlite3_column_text(stmt, 1))
            let text = String(cString: sqlite3_column_text(stmt, 2))
            let bytes = Int(sqlite3_column_bytes(stmt, 3))
            guard bytes == dimension * MemoryLayout<Float>.size, let raw = sqlite3_column_blob(stmt, 3) else { continue }
            let vec = [Float](unsafeUninitializedCapacity: dimension) { buf, count in
                memcpy(buf.baseAddress!, raw, bytes)
                count = dimension
            }
            pages[page, default: []].append(Entry(hash: hash, text: text, vector: vec))
        }
    }

    private func insertRow(_ page: RecordID, _ ord: Int, _ e: Entry) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO chunks (page, ord, hash, text, vec) VALUES (?, ?, ?, ?, ?);", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, page, -1, SEMANTIC_TRANSIENT)
        sqlite3_bind_int64(stmt, 2, Int64(ord))
        sqlite3_bind_text(stmt, 3, e.hash, -1, SEMANTIC_TRANSIENT)
        sqlite3_bind_text(stmt, 4, e.text, -1, SEMANTIC_TRANSIENT)
        e.vector.withUnsafeBytes { raw in
            _ = sqlite3_bind_blob(stmt, 5, raw.baseAddress, Int32(raw.count), SEMANTIC_TRANSIENT)
        }
        sqlite3_step(stmt)
    }

    private func deleteRows(_ page: RecordID) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "DELETE FROM chunks WHERE page = ?;", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, page, -1, SEMANTIC_TRANSIENT)
        sqlite3_step(stmt)
    }

    private func metaValue(_ key: String) -> String? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT value FROM meta WHERE key = ?;", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, SEMANTIC_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return String(cString: sqlite3_column_text(stmt, 0))
    }

    private func setMeta(_ key: String, _ value: String) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?);", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, SEMANTIC_TRANSIENT)
        sqlite3_bind_text(stmt, 2, value, -1, SEMANTIC_TRANSIENT)
        sqlite3_step(stmt)
    }

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "?"
            sqlite3_free(err)
            throw PersistenceError.sqlite(msg)
        }
    }
}
