import Foundation
import BasedCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Record-level sync protocol shared by the server and the app client.
/// pull(since) → every record with stamp > since (plus tombstones); push(records) → merged, stale returned.
public struct SyncEnvelope: Codable, Sendable {
    public var records: [Record]
    public var deletions: [RecordKey]
    public var cursor: Stamp
    public init(records: [Record], deletions: [RecordKey], cursor: Stamp) { self.records = records; self.deletions = deletions; self.cursor = cursor }
}

// MARK: - Sync v2 (paged, server-sequenced)
//
// v1 used the clients' HLC stamps as the pull cursor: a change that arrived late with an older stamp (a device
// that was offline) was never pulled by others, and local changes not yet pushed lived only in memory.
// v2: the server numbers every change it stores (`ChangeLogging.changes`), clients page through
// "everything after N", and clients push from their own persistent change log. Records stay last-writer-wins
// by HLC stamp. Spec: docs/sync-protocol.md.

/// `GET /sync/v2/pull?after=<seq>&limit=<n>` response.
public struct SyncPage: Codable, Sendable, Equatable {
    public var records: [Record]
    public var deletions: [RecordKey]
    /// Pass as `after` for the next page.
    public var next: Int64
    /// More pages are waiting.
    public var more: Bool
    public init(records: [Record], deletions: [RecordKey], next: Int64, more: Bool) {
        self.records = records; self.deletions = deletions; self.next = next; self.more = more
    }
}

/// `GET /sync/v2/wait?after=<seq>&timeout=<s>` response.
public struct SyncWait: Codable, Sendable {
    public var seq: Int64
    public init(seq: Int64) { self.seq = seq }
}

/// `POST /sync/v2/push` body.
public struct SyncPush: Codable, Sendable {
    public var records: [Record]
    public var deletions: [RecordKey]
    public init(records: [Record], deletions: [RecordKey]) { self.records = records; self.deletions = deletions }
}

/// `POST /sync/v2/push` reply: server copies that are newer than what was pushed (the client takes them).
public struct SyncPushReply: Codable, Sendable {
    public var newer: [Record]
    public var seq: Int64
    public init(newer: [Record], seq: Int64) { self.newer = newer; self.seq = seq }
}

/// Wire encoding: {"kind": "...", "data": {...}}.
extension Record: Codable {
    enum CK: String, CodingKey { case kind, data }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CK.self)
        let kind = try c.decode(RecordKind.self, forKey: .kind)
        switch kind {
        case .block: self = .block(try c.decode(Block.self, forKey: .data))
        case .database: self = .database(try c.decode(Database.self, forKey: .data))
        case .view: self = .view(try c.decode(DatabaseView.self, forKey: .data))
        case .workspace: self = .workspace(try c.decode(Workspace.self, forKey: .data))
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CK.self)
        try c.encode(key.kind, forKey: .kind)
        switch self {
        case .block(let b): try c.encode(b, forKey: .data)
        case .database(let d): try c.encode(d, forKey: .data)
        case .view(let v): try c.encode(v, forKey: .data)
        case .workspace(let w): try c.encode(w, forKey: .data)
        }
    }
}

/// Server side: lives on the VPS next to the SQLite workspace. Keeps deletion tombstones in meta.
@MainActor
public final class SyncServer {
    public let store: WorkspaceStore
    private var tombstones: [RecordKey: Stamp] = [:]
    static let tombKey = "sync.tombstones"

    public init(store: WorkspaceStore) {
        self.store = store
        if let d = store.persistence?.meta(Self.tombKey), let t = try? JSONDecoder().decode([String: Stamp].self, from: d) {
            for (k, v) in t { if let key = RecordKey(parsing: k) { tombstones[key] = v } }
        }
    }

    public func pull(since: Stamp?) -> SyncEnvelope {
        var out: [Record] = [], cursor = since ?? .zero
        for r in store.allRecords() {
            if since == nil || r.stamp > since! { out.append(r) }
            if r.stamp > cursor { cursor = r.stamp }
        }
        let dels = tombstones.filter { since == nil || $0.value > since! }
        for s in dels.values where s > cursor { cursor = s }
        return SyncEnvelope(records: out, deletions: Array(dels.keys), cursor: cursor)
    }

    /// Merge pushed records. Returns records where the server copy is newer (client should take them).
    public func push(_ env: SyncEnvelope) -> SyncEnvelope {
        let stale = store.applyRemote(env.records, deletions: env.deletions)
        let now = store.clock.current
        for d in env.deletions { tombstones[d] = now }
        if !env.deletions.isEmpty {
            let enc = Dictionary(uniqueKeysWithValues: tombstones.map { ($0.key.description, $0.value) })
            store.persistence?.setMeta(Self.tombKey, try? JSONEncoder().encode(enc))
        }
        let newer = stale.compactMap { store.record($0) }
        // (Clients don't use this cursor; scanning every record per push made pushes O(workspace).)
        return SyncEnvelope(records: newer, deletions: [], cursor: store.clock.current)
    }
}

// MARK: Server v2

extension SyncServer {
    /// Changes after `after` (server sequence), oldest first, at most `limit` records + deletions per page.
    public func pullPage(after: Int64, limit: Int = 500) -> SyncPage {
        guard let log = store.persistence as? ChangeLogging else {
            // No change log (in-memory server): one page with everything newer than nothing.
            let all = pull(since: nil)
            return SyncPage(records: all.records, deletions: all.deletions, next: 0, more: false)
        }
        let limit = max(1, min(limit, 5_000))
        let entries = (try? log.changes(after: after, limit: limit + 1)) ?? []
        let page = entries.prefix(limit)
        var records: [Record] = [], deletions: [RecordKey] = []
        for e in page {
            // Only an explicit deletion is a deletion: a row this server can't decode is skipped (BSD-16).
            if e.deleted { deletions.append(e.key) } else if let r = store.record(e.key) { records.append(r) }
        }
        return SyncPage(records: records, deletions: deletions, next: page.last?.seq ?? after, more: entries.count > limit)
    }

    /// Long poll: returns as soon as the server has changes after `after`, or after `timeout` seconds.
    /// Clients call it in a loop and sync when it reports a change — near-instant sync without polling every
    /// few seconds.
    public func waitForChanges(after: Int64, timeout: TimeInterval = 25) async -> Int64 {
        let deadline = Date().addingTimeInterval(min(max(timeout, 1), 55))
        while Date() < deadline {
            let seq = (store.persistence as? ChangeLogging)?.lastChangeSeq ?? 0
            if seq > after { return seq }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        return (store.persistence as? ChangeLogging)?.lastChangeSeq ?? 0
    }

    /// Merges a client's changes (last writer wins); returns server copies that are newer than the pushed ones.
    public func pushV2(_ p: SyncPush) -> SyncPushReply {
        let env = push(SyncEnvelope(records: p.records, deletions: p.deletions, cursor: .zero))
        return SyncPushReply(newer: env.records, seq: (store.persistence as? ChangeLogging)?.lastChangeSeq ?? 0)
    }
}

extension RecordKey {
    init?(parsing s: String) {
        guard let i = s.firstIndex(of: ":"), let kind = RecordKind(rawValue: String(s[..<i])) else { return nil }
        self.init(kind, String(s[s.index(after: i)...]))
    }
}

/// Client side (app): pushes local changes and pulls remote ones from a Based server over HTTPS.
/// Works alongside iCloud: both transports feed the same store with last-writer-wins stamps.
@MainActor
public final class ServerSync {
    public let store: WorkspaceStore
    public var baseURL: URL
    public var token: String
    public private(set) var cursor: Stamp?
    public private(set) var lastError: String?
    public private(set) var lastSync: Date?
    public var onStatus: ((String) -> Void)?
    private var pending: Set<RecordKey> = []
    private var pendingDeletions: Set<RecordKey> = []
    private var observer: ObservationToken?
    private var timer: Task<Void, Never>?
    private var syncing = false
    static let cursorKey = "sync.server.cursor"

    public init(store: WorkspaceStore, baseURL: URL, token: String) {
        self.store = store; self.baseURL = baseURL; self.token = token
        if let d = store.persistence?.meta(Self.cursorKey) { cursor = try? JSONDecoder().decode(Stamp.self, from: d) }
    }

    public func start(interval: TimeInterval = 20) {
        observer = store.observe { [weak self] change in
            guard let self, change.origin.isLocalWrite else { return }
            for k in change.keys { if self.store.record(k) == nil { self.pendingDeletions.insert(k) } else { self.pending.insert(k) } }
            self.schedulePush()
        }
        // v2 servers: wait for remote changes with a long poll and pull right away.
        listener = Task { [weak self] in
            var backoff: UInt64 = 2
            while !Task.isCancelled {
                guard let self else { return }
                if self.usesV2 != true {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    continue
                }
                do {
                    var c = URLComponents(url: self.baseURL.appendingPathComponent("sync/v2/wait"), resolvingAgainstBaseURL: false)!
                    c.queryItems = [URLQueryItem(name: "after", value: String(self.readSeq(Self.pulledKey))), URLQueryItem(name: "timeout", value: "25")]
                    let r: SyncWait = try await self.get(c.url!)
                    backoff = 2
                    if r.seq > self.readSeq(Self.pulledKey) { await self.syncNow() }
                } catch {
                    try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                    backoff = min(backoff * 2, 60)
                }
            }
        }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncNow()
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }
    public func stop() { observer?.cancel(); timer?.cancel(); listener?.cancel(); pushTask?.cancel() }

    private var listener: Task<Void, Never>?
    private var pushTask: Task<Void, Never>?

    /// Local edits reach the server ~1.5 s after typing pauses (instead of the next 20 s tick).
    private func schedulePush() {
        pushTask?.cancel()
        pushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await self?.syncNow()
        }
    }

    /// Server speaks v2 (paged, sequenced); nil until the first sync found out.
    public private(set) var usesV2: Bool?
    static let pushedKey = "sync.v2.pushed"     // local change-log seq up to which local changes are pushed
    static let pulledKey = "sync.v2.pulled"     // server seq up to which changes are pulled
    /// Records / deletions per request.
    public var pageSize = 500

    public func syncNow() async {
        guard !syncing else { return }
        // Can't save locally (WorkspaceStore.writeFailure): don't pull pages whose cursor would advance past
        // changes that were never stored. Resumes after the store's retryWrites() succeeds.
        guard !store.isReadOnly else { onStatus?("Sync paused: Based can't save changes on this device"); return }
        syncing = true; defer { syncing = false }
        do {
            if usesV2 != false, store.persistence is ChangeLogging {
                do {
                    try await syncV2()
                    usesV2 = true
                    return
                } catch let AIError.http(code, _) where code == 404 {
                    usesV2 = false   // older server: fall back to v1
                }
            }
            try await syncV1()
        } catch {
            lastError = "\(error)"; onStatus?("Sync error: \(error)")
        }
    }

    /// v2: push local changes from the persistent change log in pages, then pull server pages until done.
    private func syncV2() async throws {
        guard let log = store.persistence as? ChangeLogging else { return }
        // Push: every local change after the last pushed seq (survives restarts; no in-memory pending set).
        var pushed = readSeq(Self.pushedKey)
        while true {
            let entries = try log.changes(after: pushed, limit: pageSize)
            guard let last = entries.last else { break }
            let mine = entries.filter(\.local)
            if !mine.isEmpty {
                var records: [Record] = [], deletions: [RecordKey] = []
                var skipped = 0
                for e in mine {
                    // Only an explicit deletion is a deletion. A logged change whose record isn't in memory is
                    // a row this version can't decode (frozen): never push it as a deletion (BSD-16).
                    if e.deleted { deletions.append(e.key) }
                    else if let r = store.record(e.key) { records.append(r) }
                    else { skipped += 1 }
                }
                if skipped > 0 { Log.warning("Sync: \(skipped) undecodable records not pushed", category: "sync") }
                if !records.isEmpty || !deletions.isEmpty {
                    let reply: SyncPushReply = try await post("sync/v2/push", SyncPush(records: records, deletions: deletions))
                    if !reply.newer.isEmpty { store.applyRemote(reply.newer) }
                }
            }
            pushed = last.seq
            writeSeq(Self.pushedKey, pushed)
            if entries.count < pageSize { break }
        }
        // Pull
        var after = readSeq(Self.pulledKey)
        var received = 0
        while true {
            var c = URLComponents(url: baseURL.appendingPathComponent("sync/v2/pull"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "limit", value: String(pageSize))]
            let page: SyncPage = try await get(c.url!)
            if !page.records.isEmpty || !page.deletions.isEmpty {
                // Pulled changes are logged as remote (local = false), so they're never pushed back.
                _ = store.applyRemote(page.records, deletions: page.deletions)
                received += page.records.count + page.deletions.count
            }
            after = page.next
            writeSeq(Self.pulledKey, after)
            if !page.more { break }
        }
        lastSync = Date(); lastError = nil
        onStatus?("Synced \(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)) · live (protocol v2)"
                  + (received > 0 ? " · \(received) changes" : ""))
    }

    private func readSeq(_ key: String) -> Int64 {
        store.persistence?.meta(key).flatMap { Int64(String(decoding: $0, as: UTF8.self)) } ?? 0
    }
    private func writeSeq(_ key: String, _ v: Int64) { store.persistence?.setMeta(key, Data(String(v).utf8)) }

    private func syncV1() async throws {
        do {
            // Push
            if !pending.isEmpty || !pendingDeletions.isEmpty || cursor == nil {
                let records = cursor == nil ? store.allRecords() : pending.compactMap { store.record($0) }
                let env = SyncEnvelope(records: records, deletions: Array(pendingDeletions), cursor: cursor ?? .zero)
                let reply: SyncEnvelope = try await post("sync/push", env)
                pending.removeAll(); pendingDeletions.removeAll()
                if !reply.records.isEmpty { store.applyRemote(reply.records) }
            }
            // Pull
            var url = baseURL.appendingPathComponent("sync/pull")
            if let cursor, let d = try? JSONEncoder().encode(cursor), let s = String(data: d, encoding: .utf8) {
                var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!; c.queryItems = [URLQueryItem(name: "since", value: s)]; url = c.url!
            }
            let env: SyncEnvelope = try await get(url)
            if !env.records.isEmpty || !env.deletions.isEmpty {
                let stale = store.applyRemote(env.records, deletions: env.deletions)
                pending.formUnion(stale)
            }
            cursor = env.cursor
            store.persistence?.setMeta(Self.cursorKey, try? JSONEncoder().encode(env.cursor))
            lastSync = Date(); lastError = nil
            onStatus?("Synced \(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)) · older server (protocol v1, every 20 s) — update based-server for live sync")
        }
    }

    /// Test hook: replaces URLSession (path, method, body) → (status, data).
    public var transport: ((URLRequest) async throws -> (Int, Data))?

    private func send(_ req: URLRequest) async throws -> Data {
        let (status, data): (Int, Data)
        if let transport { (status, data) = try await transport(req) }
        else {
            let (d, resp) = try await URLSession.shared.data(for: req)
            (status, data) = ((resp as? HTTPURLResponse)?.statusCode ?? 0, d)
        }
        guard status == 200 else { throw AIError.http(status, String(decoding: data.prefix(500), as: UTF8.self)) }
        return data
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try JSONDecoder().decode(T.self, from: try await send(req))
    }

    private func post<T: Decodable>(_ path: String, _ body: some Encodable) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try JSONDecoder().decode(T.self, from: try await send(req))
    }
}
