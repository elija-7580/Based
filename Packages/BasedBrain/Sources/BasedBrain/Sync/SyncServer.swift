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
        return SyncEnvelope(records: newer, deletions: [], cursor: pull(since: nil).cursor)
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
            guard let self, change.origin == .local || change.origin == .undo || change.origin == .redo else { return }
            for k in change.keys { if self.store.record(k) == nil { self.pendingDeletions.insert(k) } else { self.pending.insert(k) } }
        }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncNow()
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }
    public func stop() { observer?.cancel(); timer?.cancel() }

    public func syncNow() async {
        guard !syncing else { return }
        syncing = true; defer { syncing = false }
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
            var req = URLRequest(url: url); req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw AIError.http((resp as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self)) }
            let env = try JSONDecoder().decode(SyncEnvelope.self, from: data)
            if !env.records.isEmpty || !env.deletions.isEmpty {
                let stale = store.applyRemote(env.records, deletions: env.deletions)
                pending.formUnion(stale)
            }
            cursor = env.cursor
            store.persistence?.setMeta(Self.cursorKey, try? JSONEncoder().encode(env.cursor))
            lastSync = Date(); lastError = nil
            onStatus?("Synced \(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short))")
        } catch {
            lastError = "\(error)"; onStatus?("Sync error: \(error)")
        }
    }

    private func post<T: Decodable>(_ path: String, _ body: some Encodable) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw AIError.http((resp as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self)) }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
