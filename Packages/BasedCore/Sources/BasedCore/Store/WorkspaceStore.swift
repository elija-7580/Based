import Foundation

public enum ChangeOrigin: Sendable {
    case local, undo, redo, remote, load
    /// Records restored from an archive (BSD-26): kept with their stamps and without undo — like `.remote` —
    /// but logged as local changes and reported to `onLocalChange`, so sync pushes them to the server.
    case `import`

    /// Changes that originate on this device and must be uploaded (change log `local=1`, `onLocalChange`).
    public var isLocalWrite: Bool {
        switch self {
        case .local, .undo, .redo, .import: return true
        case .remote, .load: return false
        }
    }
}

/// What changed in one committed transaction.
public struct ChangeSet: Sendable {
    public var keys: Set<RecordKey> = []
    /// Parent keys (`ParentRef.key`) whose child lists changed.
    public var parents: Set<String> = []
    public var origin: ChangeOrigin

    /// BSD-39: rows changed per database (before or after the change the row lived in that database, so a row
    /// moved between databases is listed under both). Filled by the store for observers.
    public var databaseRows: [RecordID: Set<RecordID>] = [:]
    /// BSD-39: databases whose own record (schema, title …) changed.
    public var databaseSchemas: Set<RecordID> = []
    /// BSD-39: databases one of whose views changed.
    public var databaseViews: Set<RecordID> = []

    public var isEmpty: Bool { keys.isEmpty && parents.isEmpty }
    public var blockIDs: [RecordID] { keys.filter { $0.kind == .block }.map(\.id) }
    /// Every database touched by this change (rows, schema or views).
    public var changedDatabases: Set<RecordID> { databaseSchemas.union(databaseViews).union(databaseRows.keys) }
}

public enum InsertPosition: Sendable, Equatable {
    case start, end
    case after(RecordID)
    case before(RecordID)
}

struct Snapshot { var value: Record? }

struct UndoEntry {
    var name: String
    var before: [RecordKey: Snapshot]
    var after: [RecordKey: Snapshot]
    var coalesceKey: String?
    var time: Date
}

public final class ObservationToken {
    private let onCancel: () -> Void
    init(_ onCancel: @escaping () -> Void) { self.onCancel = onCancel }
    public func cancel() { onCancel() }
    deinit { onCancel() }
}

/// Mutation context of one transaction. Records the state before the first
/// touch of every record, for undo and change notification.
@MainActor
public final class Tx {
    unowned let store: WorkspaceStore
    var before: [RecordKey: Snapshot] = [:]
    var order: [RecordKey] = []
    var parents: Set<String> = []
    /// Keep `updatedAt` / `updatedBy` of written records (imports carry the source's timestamps).
    public var preserveTimestamps = false
    /// Stamps for deletions in this transaction (remote tombstones). Local deletions get a fresh stamp.
    var tombstoneStamps: [RecordKey: Stamp] = [:]
    /// Records written (and restamped) even though their content didn't change.
    var forced: Set<RecordKey> = []

    init(store: WorkspaceStore) { self.store = store }

    private func touch(_ key: RecordKey) {
        if before[key] == nil {
            before[key] = Snapshot(value: store.record(key))
            order.append(key)
        }
    }

    public func block(_ id: RecordID) -> Block? { store.blocks[id] }
    public func database(_ id: RecordID) -> Database? { store.databases[id] }
    public func view(_ id: RecordID) -> DatabaseView? { store.views[id] }

    public func put(_ b: Block) { touch(RecordKey(.block, b.id)); store._setBlock(b, &parents) }
    public func put(_ d: Database) { touch(RecordKey(.database, d.id)); store._setDatabase(d) }
    public func put(_ v: DatabaseView) { touch(RecordKey(.view, v.id)); store._setView(v, &parents) }
    public func put(_ w: Workspace) { touch(RecordKey(.workspace, w.id)); store._setWorkspace(w) }

    public func put(_ r: Record) {
        switch r {
        case .block(let b): put(b)
        case .database(let d): put(d)
        case .view(let v): put(v)
        case .workspace(let w): put(w)
        }
    }

    public func remove(_ key: RecordKey) {
        guard store.record(key) != nil else { return }
        touch(key)
        store._remove(key, &parents)
    }

    public func removeBlock(_ id: RecordID) { remove(RecordKey(.block, id)) }

    /// Writes the record with a new stamp although its content is unchanged, so it wins against older
    /// tombstones elsewhere (restoring a page re-stamps its whole subtree, BSD-24).
    public func restamp(_ key: RecordKey) {
        guard store.record(key) != nil else { return }
        touch(key)
        forced.insert(key)
    }

    public func update(_ id: RecordID, _ f: (inout Block) -> Void) {
        guard var b = store.blocks[id] else { return }
        f(&b)
        put(b)
    }

    public func updateDatabase(_ id: RecordID, _ f: (inout Database) -> Void) {
        guard var d = store.databases[id] else { return }
        f(&d)
        put(d)
    }

    public func updateView(_ id: RecordID, _ f: (inout DatabaseView) -> Void) {
        guard var v = store.views[id] else { return }
        f(&v)
        put(v)
    }

    public func updateWorkspace(_ f: (inout Workspace) -> Void) {
        var w = store.workspace
        f(&w)
        put(w)
    }

    /// A sort key for inserting into `parent` at `position`.
    public func sortKey(in parent: ParentRef, _ position: InsertPosition) -> String {
        let ids = store.children(of: parent)
        func key(_ id: RecordID) -> String? { store.blocks[id]?.sortKey }
        switch position {
        case .start:
            return FractionalIndex.between(nil, ids.first.flatMap(key))
        case .end:
            return FractionalIndex.between(ids.last.flatMap(key), nil)
        case .after(let id):
            guard let i = ids.firstIndex(of: id) else { return FractionalIndex.between(ids.last.flatMap(key), nil) }
            let next = i + 1 < ids.count ? key(ids[i + 1]) : nil
            return FractionalIndex.between(key(id), next)
        case .before(let id):
            guard let i = ids.firstIndex(of: id) else { return FractionalIndex.between(nil, ids.first.flatMap(key)) }
            let prev = i > 0 ? key(ids[i - 1]) : nil
            return FractionalIndex.between(prev, key(id))
        }
    }

    /// `count` sort keys for consecutive insertion at `position`.
    public func sortKeys(_ count: Int, in parent: ParentRef, _ position: InsertPosition) -> [String] {
        guard count > 0 else { return [] }
        let ids = store.children(of: parent)
        func key(_ id: RecordID) -> String? { store.blocks[id]?.sortKey }
        var lo: String? = nil, hi: String? = nil
        switch position {
        case .start: hi = ids.first.flatMap(key)
        case .end: lo = ids.last.flatMap(key)
        case .after(let id):
            lo = key(id)
            if let i = ids.firstIndex(of: id), i + 1 < ids.count { hi = key(ids[i + 1]) }
        case .before(let id):
            hi = key(id)
            if let i = ids.firstIndex(of: id), i > 0 { lo = key(ids[i - 1]) }
        }
        return FractionalIndex.keys(count: count, between: lo, hi)
    }
}

public protocol Persistence: AnyObject {
    func loadAll() throws -> [Record]
    func write(upserts: [Record], deletions: [RecordKey]) throws
    func meta(_ key: String) -> Data?
    func setMeta(_ key: String, _ value: Data?)
    /// Throws if the storage can't be written right now (used by `WorkspaceStore.retryWrites`).
    func checkWritable() throws
    /// `loadAll` plus the keys of stored rows that couldn't be decoded (default: none).
    func loadAllReporting() throws -> LoadResult
}

extension Persistence {
    public func checkWritable() throws { try write(upserts: [], deletions: []) }
    public func loadAllReporting() throws -> LoadResult { LoadResult(records: try loadAll()) }
}

/// Result of loading a workspace: the records plus rows that couldn't be decoded (key → error text).
public struct LoadResult {
    public var records: [Record] = []
    public var undecodable: [RecordKey: String] = [:]
    public init(records: [Record] = [], undecodable: [RecordKey: String] = [:]) {
        self.records = records; self.undecodable = undecodable
    }
}

/// Errors of `WorkspaceStore.tryTransact`.
public enum StoreError: Error, CustomStringConvertible, Equatable {
    /// The store couldn't write to disk and accepts no changes until `retryWrites()` succeeds.
    case readOnly(String)
    public var description: String {
        switch self {
        case .readOnly(let m): return "Based can't save changes (\(m))"
        }
    }
}

/// The store couldn't write to its persistence: it's read-only until `retryWrites()` succeeds.
public struct WriteFailure: Sendable, Equatable {
    /// The underlying error, as text.
    public var message: String
    /// When writing first failed.
    public var since: Date
    /// Changes rejected since then (local transactions, undo/redo, remote batches).
    public var rejected: Int
    public init(message: String, since: Date = Date(), rejected: Int = 0) {
        self.message = message; self.since = since; self.rejected = rejected
    }
}

/// One entry of the persistent change log: the latest change of a record, numbered by a per-database sequence.
/// A record appears at most once (its newest change). `local` = made on this device (not received by sync).
public struct ChangeEntry: Sendable, Equatable {
    public var seq: Int64
    public var key: RecordKey
    public var deleted: Bool
    public var local: Bool
    /// For a deletion: the HLC stamp of the delete (a stamped tombstone, ADR 0002 / BSD-24). Nil for upserts and
    /// for deletions logged before format v3 or received without a stamp.
    public var deletedStamp: Stamp?
    public init(seq: Int64, key: RecordKey, deleted: Bool, local: Bool, deletedStamp: Stamp? = nil) {
        self.seq = seq; self.key = key; self.deleted = deleted; self.local = local; self.deletedStamp = deletedStamp
    }
}

/// Persistence with a change log (Sync v2): every write is numbered, so a server can page through
/// "everything after N" and a client knows which local changes it hasn't pushed yet — across restarts.
public protocol ChangeLogging: Persistence {
    func write(upserts: [Record], deletions: [RecordKey], local: Bool) throws
    /// Like `write(upserts:deletions:local:)`, logging each deletion with its tombstone stamp (BSD-24).
    func write(upserts: [Record], deletions: [RecordKey], tombstones: [RecordKey: Stamp], local: Bool) throws
    /// Entries with `seq > after`, ascending, at most `limit`.
    func changes(after: Int64, limit: Int) throws -> [ChangeEntry]
    var lastChangeSeq: Int64 { get }
    /// The stamp of the record's deletion, if its latest logged change is a stamped deletion.
    func tombstone(_ key: RecordKey) -> Stamp?
    /// Removes deletion rows whose tombstone stamp is older than `cutoffMillis` (wall clock of the HLC stamp;
    /// BSD-104). Unstamped deletion rows (from before v3) are kept. Returns how many rows went and the highest
    /// `seq` among them (0 if none): a client that pulled less than that may have missed a deletion.
    func compactTombstones(olderThanMillis cutoffMillis: Int64) throws -> (removed: Int, maxSeq: Int64)
}

extension ChangeLogging {
    public func compactTombstones(olderThanMillis cutoffMillis: Int64) throws -> (removed: Int, maxSeq: Int64) { (0, 0) }
    public func write(upserts: [Record], deletions: [RecordKey], tombstones: [RecordKey: Stamp], local: Bool) throws {
        try write(upserts: upserts, deletions: deletions, local: local)
    }
    public func tombstone(_ key: RecordKey) -> Stamp? { nil }
}

/// Outcome of merging a remote batch (`WorkspaceStore.applyRemoteReporting`).
public struct RemoteMergeResult: Sendable, Equatable {
    /// Keys whose local copy is newer than what arrived (a record, or a record newer than an arriving deletion):
    /// the sender should take the local copy.
    public var stale: [RecordKey] = []
    /// Arriving records that lost against a newer local tombstone (they stay deleted), with that tombstone's stamp.
    public var tombstoned: [RecordKey: Stamp] = [:]
    public init(stale: [RecordKey] = [], tombstoned: [RecordKey: Stamp] = [:]) { self.stale = stale; self.tombstoned = tombstoned }
}

/// In-memory record cache with indexes, transactions, undo/redo, observers.
@MainActor
public final class WorkspaceStore {
    /// Records that can't be trashed or deleted (the Agent Brain page, its About page and database hosts).
    /// Trash / delete calls skip them — and any page that contains one.
    public var protectedIDs: Set<RecordID> = []
    public private(set) var blocks: [RecordID: Block] = [:]
    public private(set) var databases: [RecordID: Database] = [:]
    public private(set) var views: [RecordID: DatabaseView] = [:]
    public private(set) var workspace = Workspace()

    private var childIndex: [String: [RecordID]] = [:]
    private var viewIndex: [RecordID: [RecordID]] = [:]

    public let clock: StampClock
    public let persistence: Persistence?
    public var userID: String? = "me"
    /// Last persistence error (load or write). See `writeFailure` for the resulting state.
    public private(set) var lastError: Error?
    /// Non-nil after a write to disk failed (or the workspace couldn't be loaded): the store is read-only.
    /// The failed transaction was rolled back in memory, so memory and disk agree; every later change is rejected
    /// (`transact` rolls it back, `tryTransact` throws `StoreError.readOnly`, remote changes are queued) until
    /// `retryWrites()` succeeds. Rather block than lose edits silently.
    public private(set) var writeFailure: WriteFailure?
    public var isReadOnly: Bool { writeFailure != nil }
    /// Called when `writeFailure` is set or cleared (UI banner).
    public var onWriteFailureChanged: (() -> Void)?
    /// Remote changes that arrived while read-only; applied after `retryWrites()` succeeds.
    private var deferredRemote: [(records: [Record], deletions: [RecordKey], stamps: [RecordKey: Stamp])] = []
    /// The initial load failed: `retryWrites` loads again before accepting changes.
    private var loadFailed = false
    /// Stored records this app version can't decode (newer app, unknown block type, decoding bug). They stay
    /// untouched on disk and are never synced as deletions (BSD-16). A decodable copy that arrives by sync
    /// replaces the row and leaves this set.
    public private(set) var frozenKeys: Set<RecordKey> = []
    /// Monotonic counter bumped on every committed change (local, remote, undo). Use as a cache key.
    public private(set) var revision: Int = 0
    /// BSD-39: per database, bumped when its schema, one of its views or one of its rows changes (also a row moved
    /// in or out, trashed or restored). Typing in an ordinary page leaves every database revision alone, so caches
    /// keyed on it (`QueryCache`) survive. Missing = 0.
    public private(set) var databaseRevisions: [RecordID: Int] = [:]
    /// BSD-39: bumped on a full reload (`retryWrites` after a failed load): every database counts as changed.
    public private(set) var databaseEpoch: Int = 0
    public func databaseRevision(_ id: RecordID) -> Int { databaseRevisions[id] ?? 0 }
    /// `topLevelPages()` memo (the workspace level also holds every trashed import — thousands of records the
    /// sidebar re-scanned on each render).
    var topLevelCache: (revision: Int, pages: [Block])?

    /// Called after local, undo and redo commits with the changed keys (sync hook).
    public var onLocalChange: (([RecordKey]) -> Void)?

    private var observers: [UUID: (ChangeSet) -> Void] = [:]
    /// Backlink index (built lazily on first `backlinks(to:)`): block → linked pages, page → linking blocks.
    var linkTargets: [RecordID: Set<RecordID>] = [:]
    var linkSources: [RecordID: Set<RecordID>] = [:]
    var linkIndexBuilt = false
    /// Non-nil while the index is built in the background: blocks changed meanwhile (re-indexed on install).
    var linkIndexPending: Set<RecordID>?
    var linkIndexReadyHandlers: [@MainActor () -> Void] = []
    /// Revision-keyed caches for whole-workspace page lists (Home "Recents", Quick Find, link pickers).
    var recentPagesCache: (revision: Int, limit: Int, pages: [Block])?
    var allPagesCache: (revision: Int, pages: [Block])?
    /// BSD-38: maintained on every block write, so page lists never scan all blocks.
    /// Page-like blocks (pages, rows, database pages), trashed or not.
    var pageIDs = Set<RecordID>()
    /// Blocks with `trashedAt` set.
    var trashedIDs = Set<RecordID>()
    /// Bumped only when the page *structure* changes (a block appears/disappears, moves, changes type or trash
    /// state, a database changes its container) – not when text is typed. Cache key for `subpages(of:)`.
    public private(set) var hierarchyRevision: Int = 0
    var subpageCache: (revision: Int, map: [RecordID: [RecordID]])?
    /// All untrashed pages by last edit (newest first) and each entry's date, patched with `recentDirty` instead
    /// of re-sorting every page after each keystroke. Nil until `recentPages` is first used.
    var recentSorted: [(date: Date, id: RecordID)]?
    var recentDates: [RecordID: Date] = [:]
    var recentDirty = Set<RecordID>()
    /// Transactions slower than this are logged as warnings (perf diagnostics).
    public var slowTransactionThreshold: TimeInterval = 0.05
    private var undoStack: [UndoEntry] = []
    private var redoStack: [UndoEntry] = []
    public var undoCoalesceInterval: TimeInterval = 1.5
    public var maxUndo = 300

    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }
    public var undoActionName: String? { undoStack.last?.name }
    public var redoActionName: String? { redoStack.last?.name }

    public init(persistence: Persistence? = nil, node: String? = nil) {
        let nodeID: String
        if let node { nodeID = node }
        else if let data = persistence?.meta("node"), let s = String(data: data, encoding: .utf8) { nodeID = s }
        else {
            nodeID = String(RecordIDs.make().prefix(8))
            persistence?.setMeta("node", Data(nodeID.utf8))
        }
        clock = StampClock(node: nodeID)
        self.persistence = persistence
        if let writer = persistence as? PersistenceWriter {
            // BSD-42: background writes report failures asynchronously; the store turns read-only on the main actor.
            writer.onFailure = { [weak self] error in
                Task { @MainActor in self?.backgroundWriteFailed(error) }
            }
        }
        var loadedWorkspace = false
        if let persistence {
            do {
                let loaded = try persistence.loadAllReporting()
                noteUndecodable(loaded.undecodable)
                loadedWorkspace = bulkLoad(loaded.records)
            } catch {
                // Don't write anything into a database we couldn't read: start read-only with an in-memory
                // workspace and let `retryWrites()` load again.
                lastError = error
                loadFailed = true
                writeFailure = WriteFailure(message: "load failed: \(error)")
                Log.error("Workspace could not be loaded: \(error) — store is read-only", category: "store")
                _setWorkspace(Workspace())
                return
            }
        }
        if !loadedWorkspace {
            createFreshWorkspace()
        }
    }

    /// No readable workspace record: create a new one. If the stored one exists but can't be decoded (written by
    /// a newer version, damaged), copy it to `quarantine` first — the fresh record replaces that row (BSD-23).
    private func createFreshWorkspace() {
        let key = RecordKey(.workspace, Workspace.mainID)
        if frozenKeys.contains(key), let sqlite = persistence?.sqliteBase {
            do {
                persistence?.flushPendingWrites()
                try sqlite.preserveInQuarantine(key, reason: "undecodable workspace record replaced by a new one")
                frozenKeys.remove(key)
            } catch {
                Log.error("Could not preserve the undecodable workspace record: \(error) — keeping it, workspace stays in memory",
                          category: "store")
                _setWorkspace(Workspace())
                return
            }
        } else if frozenKeys.contains(key) {
            _setWorkspace(Workspace())
            return
        }
        transact("Create workspace", undoable: false) { tx in tx.put(Workspace()) }
    }

    private func noteUndecodable(_ undecodable: [RecordKey: String]) {
        guard !undecodable.isEmpty else { return }
        frozenKeys.formUnion(undecodable.keys)
        let sample = undecodable.sorted { $0.key.description < $1.key.description }.prefix(5)
            .map { "\($0.key): \($0.value)" }.joined(separator: " · ")
        Log.error("\(undecodable.count) records could not be decoded and are kept unchanged (not synced): \(sample)",
                  category: "store", metadata: ["count": String(undecodable.count)])
    }

    // MARK: Lookup

    public func record(_ key: RecordKey) -> Record? {
        switch key.kind {
        case .block: return blocks[key.id].map(Record.block)
        case .database: return databases[key.id].map(Record.database)
        case .view: return views[key.id].map(Record.view)
        case .workspace: return workspace.id == key.id ? .workspace(workspace) : nil
        }
    }

    /// All child ids of a parent in order (including trashed pages).
    public func children(of parent: ParentRef) -> [RecordID] { childIndex[parent.key] ?? [] }

    /// Child blocks in order, excluding trashed pages.
    public func childBlocks(of parent: ParentRef) -> [Block] {
        children(of: parent).compactMap { blocks[$0] }.filter { $0.trashedAt == nil }
    }

    public func viewIDs(forBlock id: RecordID) -> [RecordID] { viewIndex[id] ?? [] }
    public func views(forBlock id: RecordID) -> [DatabaseView] { viewIDs(forBlock: id).compactMap { views[$0] } }

    // MARK: Observers

    public func observe(_ handler: @escaping (ChangeSet) -> Void) -> ObservationToken {
        let id = UUID()
        observers[id] = handler
        return ObservationToken { [weak self] in
            MainActor.assumeIsolated { _ = self?.observers.removeValue(forKey: id) }
        }
    }

    // MARK: Transactions

    /// Run mutations as one atomic, undoable unit.
    /// If the store is read-only (`writeFailure`) or the write fails now, the mutations are rolled back and the
    /// body's result is returned anyway; use `tryTransact` to get `StoreError.readOnly` instead.
    @discardableResult
    public func transact<T>(_ name: String, coalesce: String? = nil, undoable: Bool = true,
                            _ body: (Tx) throws -> T) rethrows -> T {
        try perform(name, coalesce: coalesce, undoable: undoable, body).result
    }

    /// Like `transact`, but throws `StoreError.readOnly` when the change wasn't saved (store read-only or the
    /// write failed); the body doesn't run at all while the store is read-only.
    @discardableResult
    public func tryTransact<T>(_ name: String, coalesce: String? = nil, undoable: Bool = true,
                               _ body: (Tx) throws -> T) throws -> T {
        if let f = writeFailure {
            writeFailure?.rejected += 1
            throw StoreError.readOnly(f.message)
        }
        let (result, saved) = try perform(name, coalesce: coalesce, undoable: undoable, body)
        if !saved { throw StoreError.readOnly(writeFailure?.message ?? "write failed") }
        return result
    }

    private func perform<T>(_ name: String, coalesce: String?, undoable: Bool,
                            _ body: (Tx) throws -> T) rethrows -> (result: T, saved: Bool) {
        let tx = Tx(store: self)
        let start = DispatchTime.now().uptimeNanoseconds
        do {
            let result = try body(tx)
            let saved = commit(tx, name: name, coalesce: coalesce, origin: .local, undoable: undoable)
            let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            if ms > slowTransactionThreshold * 1000 {
                Log.warning("Slow transaction “\(name)”: \(Int(ms)) ms, \(tx.order.count) records", category: "store",
                            metadata: ["ms": String(Int(ms)), "records": String(tx.order.count)])
            }
            return (result, saved)
        } catch {
            rollback(tx)
            throw error
        }
    }

    private func rollback(_ tx: Tx) {
        var ignored = Set<String>()
        for key in tx.order.reversed() { restore(key, tx.before[key]?.value, &ignored) }
    }

    private func restore(_ key: RecordKey, _ value: Record?, _ parents: inout Set<String>) {
        if let value {
            switch value {
            case .block(let b): _setBlock(b, &parents)
            case .database(let d): _setDatabase(d)
            case .view(let v): _setView(v, &parents)
            case .workspace(let w): _setWorkspace(w)
            }
        } else {
            _remove(key, &parents)
        }
    }

    /// Writes the transaction and publishes it. Returns false (and rolls the transaction back in memory) if the
    /// store is read-only or the write failed; undo, observers and `onLocalChange` then don't run.
    @discardableResult
    private func commit(_ tx: Tx, name: String, coalesce: String?, origin: ChangeOrigin, undoable: Bool) -> Bool {
        if writeFailure == nil, let e = (persistence as? PersistenceWriter)?.failure { backgroundWriteFailed(e) }
        if persistence != nil, writeFailure != nil, !tx.order.isEmpty {
            rollback(tx)
            writeFailure?.rejected += 1
            return false
        }
        var upserts: [Record] = []
        var deletions: [RecordKey] = []
        var tombstones: [RecordKey: Stamp] = [:]
        var change = ChangeSet(origin: origin)
        var before: [RecordKey: Snapshot] = [:]
        var after: [RecordKey: Snapshot] = [:]
        let now = Date()
        let restamp = origin != .remote && origin != .load && origin != .import
        for key in tx.order {
            let prev = tx.before[key]?.value
            guard var cur = record(key) else {
                if prev != nil {
                    deletions.append(key)
                    // Stamped tombstone (ADR 0002): remote ones carry the sender's stamp, local ones get a new one.
                    if let s = tx.tombstoneStamps[key] { tombstones[key] = s } else if restamp { tombstones[key] = clock.now() }
                    change.keys.insert(key)
                    before[key] = Snapshot(value: prev)
                    after[key] = Snapshot(value: nil)
                }
                continue
            }
            let unchanged = cur == prev
            if unchanged && !tx.forced.contains(key) { continue }
            if restamp {
                cur = stamped(cur, now: now, keepTimes: tx.preserveTimestamps || unchanged)
                var ignored = Set<String>()
                restore(key, cur, &ignored)
            }
            upserts.append(cur)
            change.keys.insert(key)
            before[key] = Snapshot(value: prev)
            after[key] = Snapshot(value: cur)
        }
        change.parents = tx.parents
        guard !change.isEmpty else { return true }

        if let persistence {
            do {
                if let log = persistence as? ChangeLogging {
                    try log.write(upserts: upserts, deletions: deletions, tombstones: tombstones, local: origin.isLocalWrite)
                } else {
                    try persistence.write(upserts: upserts, deletions: deletions)
                }
            } catch {
                // Memory must match disk: undo the in-memory change and stop accepting changes.
                rollback(tx)
                lastError = error
                writeFailure = WriteFailure(message: "\(error)", rejected: 1)
                Log.error("Saving “\(name)” failed: \(error) — store is read-only until a retry succeeds", category: "store",
                          metadata: ["records": String(upserts.count + deletions.count)])
                onWriteFailureChanged?()
                return false
            }
        }

        if origin == .local && undoable {
            if let c = coalesce, var top = undoStack.last, top.coalesceKey == c,
               now.timeIntervalSince(top.time) < undoCoalesceInterval {
                for (k, v) in before where top.before[k] == nil { top.before[k] = v }
                for (k, v) in after { top.after[k] = v }
                top.time = now
                undoStack[undoStack.count - 1] = top
            } else {
                undoStack.append(UndoEntry(name: name, before: before, after: after, coalesceKey: coalesce, time: now))
                if undoStack.count > maxUndo { undoStack.removeFirst(undoStack.count - maxUndo) }
            }
            redoStack.removeAll()
        }

        if origin.isLocalWrite {
            onLocalChange?(Array(change.keys))
        }
        revision &+= 1
        noteDatabaseChanges(&change, before: before, after: after)
        if linkIndexBuilt { for k in change.keys where k.kind == .block { reindexLinks(k.id) } }
        else if linkIndexPending != nil { for k in change.keys where k.kind == .block { linkIndexPending?.insert(k.id) } }
        let observeStart = DispatchTime.now().uptimeNanoseconds
        for handler in observers.values { handler(change) }
        let observeMs = Double(DispatchTime.now().uptimeNanoseconds - observeStart) / 1_000_000
        if observeMs > slowTransactionThreshold * 1000 {
            Log.warning("Store observers took \(Int(observeMs)) ms for “\(name)”", category: "store")
        }
        return true
    }

    /// BSD-39: which databases a committed change touches; bumps their `databaseRevisions` and records the
    /// changed rows in the change set (observers like `QueryCache` drop only those rows' memoized values).
    private func noteDatabaseChanges(_ change: inout ChangeSet, before: [RecordKey: Snapshot], after: [RecordKey: Snapshot]) {
        func note(_ r: Record?) {
            switch r {
            case .block(let b)?:
                if case .database(let d) = b.parent { change.databaseRows[d, default: []].insert(b.id) }
            case .database(let d)?: change.databaseSchemas.insert(d.id)
            case .view(let v)?: change.databaseViews.insert(v.databaseID)
            default: break
            }
        }
        for (key, snap) in before { note(snap.value); note(after[key]?.value) }
        for id in change.changedDatabases { databaseRevisions[id, default: 0] &+= 1 }
    }

    /// BSD-42: a background write (`PersistenceWriter`) failed. The change is already visible in memory and can't
    /// be rolled back; the writer keeps it (and everything after it) pending, `retryWrites()` saves it. From now on
    /// the store is read-only as after a synchronous failure.
    func backgroundWriteFailed(_ error: Error) {
        // A late notification after a successful retry: nothing is failing any more.
        guard writeFailure == nil, (persistence as? PersistenceWriter)?.failure != nil else { return }
        lastError = error
        writeFailure = WriteFailure(message: "\(error)")
        Log.error("Saving in the background failed: \(error) — store is read-only until a retry succeeds; unsaved changes are kept",
                  category: "store")
        onWriteFailureChanged?()
    }

    /// Changes not yet saved by a background writer (0 for synchronous persistence).
    public var unsavedChangeCount: Int { (persistence as? PersistenceWriter)?.pendingCount ?? 0 }

    /// Blocks until queued background writes are saved (sync readers, tests). False if some are unsaved.
    @discardableResult
    public func flushWrites() -> Bool { persistence?.flushPendingWrites() ?? true }

    /// Waits until queued background writes are saved without blocking the main thread.
    @discardableResult
    public func flush() async -> Bool {
        guard let writer = persistence as? PersistenceWriter else { return true }
        return await writer.flush()
    }

    /// Blocks at most `timeout` seconds until background writes are saved (app quit / background).
    @discardableResult
    public func flushSync(timeout: TimeInterval) -> Bool {
        guard let writer = persistence as? PersistenceWriter else { return true }
        return writer.flushSync(timeout: timeout)
    }

    /// Tries to leave the read-only state: checks that the persistence can be written (and loads the workspace
    /// again if the first load failed), then applies remote changes that arrived meanwhile.
    /// Returns true if the store accepts changes again.
    @discardableResult
    public func retryWrites() -> Bool {
        guard let failure = writeFailure else { return true }
        guard let persistence else { writeFailure = nil; onWriteFailureChanged?(); return true }
        do {
            try persistence.checkWritable()
            if loadFailed {
                let loaded = try persistence.loadAllReporting()
                noteUndecodable(loaded.undecodable)
                let records = loaded.records
                loadFailed = false
                lastError = nil
                writeFailure = nil
                if !bulkLoad(records) {
                    createFreshWorkspace()
                }
                revision &+= 1
                databaseEpoch &+= 1
                // A full reload: observers see every parent as changed.
                var all = ChangeSet(origin: .load)
                all.keys = Set(allRecords().map(\.key))
                all.parents = Set(childIndex.keys)
                for handler in observers.values { handler(all) }
            }
        } catch {
            lastError = error
            writeFailure = WriteFailure(message: "\(error)", since: failure.since, rejected: failure.rejected)
            Log.warning("Retrying writes failed: \(error)", category: "store")
            return false
        }
        writeFailure = nil
        Log.info("Store writable again (\(failure.rejected) changes were rejected while read-only)", category: "store")
        onWriteFailureChanged?()
        let queued = deferredRemote
        deferredRemote = []
        for batch in queued { applyRemote(batch.records, deletions: batch.deletions, deletionStamps: batch.stamps) }
        return writeFailure == nil
    }

    private func stamped(_ r: Record, now: Date, keepTimes: Bool = false) -> Record {
        let s = clock.now()
        switch r {
        case .block(var b):
            b.stamp = s
            if !keepTimes { b.updatedAt = now; b.updatedBy = userID }
            return .block(b)
        case .database(var d):
            d.stamp = s; d.updatedAt = now
            return .database(d)
        case .view(var v):
            v.stamp = s; v.updatedAt = now
            return .view(v)
        case .workspace(var w):
            w.stamp = s; w.updatedAt = now
            return .workspace(w)
        }
    }

    /// Forget undo/redo history (after onboarding or imports).
    public func clearUndoHistory() {
        undoStack.removeAll()
        redoStack.removeAll()
    }

    /// Stop the current typing burst from merging with the next edit.
    public func breakUndoCoalescing() {
        if var top = undoStack.last { top.coalesceKey = nil; undoStack[undoStack.count - 1] = top }
    }

    /// What an undo or redo did (BSD-27).
    public struct UndoOutcome: Equatable, Sendable {
        /// Action name of the step that was undone/redone (nil = nothing to do).
        public var name: String?
        /// Records restored.
        public var applied = 0
        /// Records left alone because another device, agent or sync changed them since (no overwrite, no revival).
        public var skipped = 0
        /// Whole steps dropped because every record in them had changed elsewhere.
        public var droppedSteps = 0
        public var partial: Bool { applied > 0 && skipped > 0 }
    }

    /// Undoes the last local step, but only for records still as that step left them (three-way check, BSD-27):
    /// a record changed or deleted elsewhere since (sync, an agent, another window) keeps that newer state, and a
    /// record deleted elsewhere is never brought back. A step none of whose records can be undone is dropped and
    /// the next one is tried.
    @discardableResult
    public func undo() -> UndoOutcome {
        step(undo: true)
    }

    /// Redoes the last undone step under the same rule as `undo()`.
    @discardableResult
    public func redo() -> UndoOutcome {
        step(undo: false)
    }

    /// No `inout` stacks here: observers that run inside `commit` may read `canUndo` / `canRedo`.
    private func step(undo: Bool) -> UndoOutcome {
        let origin: ChangeOrigin = undo ? .undo : .redo
        let restore: KeyPath<UndoEntry, [RecordKey: Snapshot]> = undo ? \.before : \.after
        let expect: KeyPath<UndoEntry, [RecordKey: Snapshot]> = undo ? \.after : \.before
        var outcome = UndoOutcome()
        while let entry = undo ? undoStack.popLast() : redoStack.popLast() {
            var keys: [RecordKey] = []
            var skipped = 0
            for key in entry[keyPath: restore].keys.sorted(by: { $0.id < $1.id }) {
                if Self.sameContent(record(key), entry[keyPath: expect][key]?.value) { keys.append(key) } else { skipped += 1 }
            }
            outcome.name = entry.name
            outcome.skipped += skipped
            guard !keys.isEmpty else {
                outcome.droppedSteps += 1
                Log.info("\(origin == .undo ? "Undo" : "Redo") skipped “\(entry.name)”: changed elsewhere since", category: "store")
                continue
            }
            let tx = Tx(store: self)
            for key in keys { apply(entry[keyPath: restore][key]?.value, key, tx) }
            guard commit(tx, name: entry.name, coalesce: nil, origin: origin, undoable: false) else {
                if undo { undoStack.append(entry) } else { redoStack.append(entry) }   // not saved: keep it
                outcome.skipped -= skipped
                return outcome
            }
            outcome.applied = keys.count
            // The opposite step only covers what was actually restored.
            var moved = entry
            moved.coalesceKey = nil
            moved.before = entry.before.filter { keys.contains($0.key) }
            moved.after = entry.after.filter { keys.contains($0.key) }
            if undo { redoStack.append(moved) } else { undoStack.append(moved) }
            if skipped > 0 {
                Log.info("\(origin == .undo ? "Undo" : "Redo") of “\(entry.name)”: \(skipped) record(s) changed elsewhere, left as they are",
                         category: "store")
            }
            return outcome
        }
        return outcome
    }

    /// Same record content, ignoring what every write changes anyway (stamp, `updatedAt`, `updatedBy`).
    static func sameContent(_ a: Record?, _ b: Record?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (.block(var x)?, .block(var y)?):
            x.stamp = .zero; y.stamp = .zero; x.updatedAt = y.updatedAt; x.updatedBy = y.updatedBy
            return x == y
        case (.database(var x)?, .database(var y)?):
            x.stamp = .zero; y.stamp = .zero; x.updatedAt = y.updatedAt
            return x == y
        case (.view(var x)?, .view(var y)?):
            x.stamp = .zero; y.stamp = .zero; x.updatedAt = y.updatedAt
            return x == y
        case (.workspace(var x)?, .workspace(var y)?):
            x.stamp = .zero; y.stamp = .zero; x.updatedAt = y.updatedAt
            return x == y
        default: return false
        }
    }

    private func apply(_ value: Record?, _ key: RecordKey, _ tx: Tx) {
        if let value { tx.put(value) } else { tx.remove(key) }
    }

    // MARK: Remote changes

    /// Merge records from another device (last-writer-wins by stamp).
    /// Returns keys whose local version is newer and should be re-sent.
    /// While the store is read-only the batch is queued (in memory) and applied after `retryWrites()` succeeds.
    @discardableResult
    public func applyRemote(_ records: [Record], deletions: [RecordKey] = [],
                            deletionStamps: [RecordKey: Stamp] = [:]) -> [RecordKey] {
        applyRemoteReporting(records, deletions: deletions, deletionStamps: deletionStamps).stale
    }

    /// `applyRemote` with the full outcome. Deletions are stamped tombstones (ADR 0002, BSD-24): one with a stamp
    /// removes the local copy only if that copy is older (a newer edit or restore wins and is reported as stale);
    /// one without a stamp (older senders) removes it unconditionally, as before. An arriving record whose key has
    /// a newer local tombstone stays deleted and is reported in `tombstoned`.
    @discardableResult
    public func applyRemoteReporting(_ records: [Record], deletions: [RecordKey] = [],
                                     deletionStamps: [RecordKey: Stamp] = [:]) -> RemoteMergeResult {
        if persistence != nil, writeFailure != nil {
            if !records.isEmpty || !deletions.isEmpty {
                deferredRemote.append((records, deletions, deletionStamps))
                writeFailure?.rejected += 1
            }
            return RemoteMergeResult()
        }
        guard let result = merge(records, deletions: deletions, stamps: deletionStamps, origin: .remote, name: "Sync") else {
            deferredRemote.append((records, deletions, deletionStamps))
            return RemoteMergeResult()
        }
        return result
    }

    /// Merges records restored from an archive (last-writer-wins by stamp, like `applyRemote`) as origin `.import`:
    /// no restamping, no undo, but logged as local changes so sync uploads them (BSD-26).
    /// Throws `StoreError.readOnly` instead of queueing while the store can't be written.
    @discardableResult
    public func applyImported(_ records: [Record], deletions: [RecordKey] = []) throws -> [RecordKey] {
        if persistence != nil, let f = writeFailure {
            writeFailure?.rejected += 1
            throw StoreError.readOnly(f.message)
        }
        guard let result = merge(records, deletions: deletions, stamps: [:], origin: .import, name: "Import") else {
            throw StoreError.readOnly(writeFailure?.message ?? "write failed")
        }
        return result.stale
    }

    /// LWW merge shared by `applyRemote` and `applyImported`. Nil if the commit failed.
    private func merge(_ records: [Record], deletions: [RecordKey], stamps: [RecordKey: Stamp],
                       origin: ChangeOrigin, name: String) -> RemoteMergeResult? {
        let tx = Tx(store: self)
        var stale: [RecordKey] = []
        var tombstoned: [RecordKey: Stamp] = [:]
        let log = persistence as? ChangeLogging
        var unfrozen: [RecordKey] = []
        for r in records {
            if case .workspace(let w) = r, w.id != workspace.id {
                // One workspace per store (BSD-23): a record with another ID would replace it in memory and leave
                // a second row on disk. Ignore it.
                Log.warning("Ignoring a workspace record with a foreign ID (\(w.id))", category: "sync")
                continue
            }
            if frozenKeys.contains(r.key) { unfrozen.append(r.key) }
            clock.observe(r.stamp)
            if let local = record(r.key) {
                if local == r { continue }
                if local.stamp > r.stamp { stale.append(r.key); continue }
            } else if let ts = log?.tombstone(r.key), ts >= r.stamp {
                // Deleted here after this version was written: it stays deleted (no resurrection).
                tombstoned[r.key] = ts
                continue
            }
            tx.put(r)
        }
        for key in deletions {
            guard let local = record(key) else { continue }
            if let ts = stamps[key] {
                clock.observe(ts)
                if local.stamp > ts { stale.append(key); continue }
                tx.tombstoneStamps[key] = ts
            }
            tx.remove(key)
        }
        guard commit(tx, name: name, coalesce: nil, origin: origin, undoable: false) else { return nil }
        for k in unfrozen { frozenKeys.remove(k) }
        // BSD-123: rows added on two devices between syncs can share an ID number.
        let idChecks = databasesNeedingIDCheck(records)
        if !idChecks.isEmpty { repairUniqueIDs(in: idChecks) }
        return RemoteMergeResult(stale: stale, tombstoned: tombstoned)
    }

    /// Every record, for full uploads and exports.
    public func allRecords() -> [Record] {
        var out: [Record] = [.workspace(workspace)]
        out.append(contentsOf: blocks.values.map(Record.block))
        out.append(contentsOf: databases.values.map(Record.database))
        out.append(contentsOf: views.values.map(Record.view))
        return out
    }

    // MARK: Raw mutation (used by Tx only)

    /// BSD-38: keeps `pageIDs`/`trashedIDs`/`hierarchyRevision` in step with one block write.
    func noteBlockChange(old: Block?, new: Block?) {
        if let new {
            if new.type.isPageLike { pageIDs.insert(new.id) } else if old?.type.isPageLike == true { pageIDs.remove(new.id) }
            if new.trashedAt != nil { trashedIDs.insert(new.id) } else if old?.trashedAt != nil { trashedIDs.remove(new.id) }
        } else if let old {
            pageIDs.remove(old.id)
            trashedIDs.remove(old.id)
        }
        let structural: Bool = {
            guard let old, let new else { return true }
            return old.parent != new.parent || old.sortKey != new.sortKey || old.type != new.type
                || (old.trashedAt == nil) != (new.trashedAt == nil)
                || old.props.databaseID != new.props.databaseID || old.props.syncSource != new.props.syncSource
        }()
        if structural { hierarchyRevision &+= 1 }
        if recentSorted != nil, new?.type.isPageLike == true || old?.type.isPageLike == true {
            recentDirty.insert(new?.id ?? old!.id)
        }
    }

    func _setBlock(_ b: Block, _ parents: inout Set<String>) {
        let old = blocks[b.id]
        blocks[b.id] = b
        noteBlockChange(old: old, new: b)
        if let old {
            if old.parent != b.parent || old.sortKey != b.sortKey {
                removeFromIndex(old.id, parentKey: old.parent.key)
                insertIntoIndex(b)
                parents.insert(old.parent.key)
                parents.insert(b.parent.key)
            } else if old.trashedAt != b.trashedAt || old.type != b.type {
                parents.insert(b.parent.key)
            }
        } else {
            insertIntoIndex(b)
            parents.insert(b.parent.key)
        }
    }

    func _setDatabase(_ d: Database) {
        if databases[d.id]?.blockID != d.blockID { hierarchyRevision &+= 1 }
        databases[d.id] = d
    }

    func _setView(_ v: DatabaseView, _ parents: inout Set<String>) {
        let old = views[v.id]
        views[v.id] = v
        if v.widgetOf != nil {
            // Dashboard widgets aren't tabs of the block; they're reached through their dashboard's layout.
            if let old { viewIndex[old.blockID]?.removeAll { $0 == old.id } }
            parents.insert("b:" + v.blockID)
            return
        }
        if old?.blockID != v.blockID || old?.sortKey != v.sortKey || old?.widgetOf != nil {
            if let old { viewIndex[old.blockID]?.removeAll { $0 == old.id } }
            var list = viewIndex[v.blockID] ?? []
            list.removeAll { $0 == v.id }
            list.append(v.id)
            list.sort { (views[$0]?.sortKey ?? "", $0) < (views[$1]?.sortKey ?? "", $1) }
            viewIndex[v.blockID] = list
            parents.insert("b:" + v.blockID)
        }
    }

    func _setWorkspace(_ w: Workspace) { workspace = w }

    func _remove(_ key: RecordKey, _ parents: inout Set<String>) {
        switch key.kind {
        case .block:
            if let old = blocks.removeValue(forKey: key.id) {
                noteBlockChange(old: old, new: nil)
                removeFromIndex(old.id, parentKey: old.parent.key)
                parents.insert(old.parent.key)
            }
        case .database:
            if databases.removeValue(forKey: key.id) != nil { hierarchyRevision &+= 1 }
        case .view:
            if let old = views.removeValue(forKey: key.id) {
                viewIndex[old.blockID]?.removeAll { $0 == old.id }
                parents.insert("b:" + old.blockID)
            }
        case .workspace:
            break
        }
    }

    static func preferWorkspace(_ a: Workspace, over b: Workspace) -> Bool {
        if a.stamp != b.stamp { return a.stamp > b.stamp }
        if (a.id == Workspace.mainID) != (b.id == Workspace.mainID) { return a.id == Workspace.mainID }
        return a.id < b.id
    }

    /// Startup path: fills the maps in one go and sorts every child list once, instead of inserting each block
    /// into its parent's sorted list (binary search + dictionary lookups per block). Same result as `_setBlock`.
    /// Returns whether a workspace record was among them.
    func bulkLoad(_ records: [Record]) -> Bool {
        var loadedWorkspace = false
        var groups: [String: [(sortKey: String, id: RecordID)]] = [:]
        blocks.reserveCapacity(blocks.count + records.count)
        var ignored = Set<String>()
        for r in records {
            clock.observe(r.stamp)
            switch r {
            case .block(let b):
                if blocks[b.id] != nil { _setBlock(b, &ignored); continue }   // duplicate row: keep normal semantics
                blocks[b.id] = b
                if b.type.isPageLike { pageIDs.insert(b.id) }
                if b.trashedAt != nil { trashedIDs.insert(b.id) }
                groups[b.parent.key, default: []].append((b.sortKey, b.id))
            case .database(let d): _setDatabase(d)
            case .view(let v): _setView(v, &ignored)
            case .workspace(let w):
                // Exactly one workspace is used. If a file still holds several (migration v2 normally prevents
                // that), take the newest stamp, then the main ID — never "whichever row came last".
                if !loadedWorkspace || Self.preferWorkspace(w, over: workspace) { _setWorkspace(w) }
                loadedWorkspace = true
            }
        }
        hierarchyRevision &+= 1
        recentSorted = nil
        for (parent, var list) in groups {
            list.sort { ($0.sortKey, $0.id) < ($1.sortKey, $1.id) }
            if var existing = childIndex[parent], !existing.isEmpty {
                // Merge with blocks that were already indexed (rare: duplicates above).
                existing += list.map(\.id)
                existing.sort { (blocks[$0]?.sortKey ?? "", $0) < (blocks[$1]?.sortKey ?? "", $1) }
                childIndex[parent] = existing
            } else {
                childIndex[parent] = list.map(\.id)
            }
        }
        return loadedWorkspace
    }

    private func insertIntoIndex(_ b: Block) {
        let key = (b.sortKey, b.id)
        let parentKey = b.parent.key
        // Mutate in place (no copy-on-write duplication); appending at the end is O(1) amortised.
        if childIndex[parentKey] == nil { childIndex[parentKey] = [b.id]; return }
        let count = childIndex[parentKey]!.count
        if let lastID = childIndex[parentKey]!.last, (blocks[lastID]?.sortKey ?? "", lastID) < key {
            childIndex[parentKey]!.append(b.id); return
        }
        var lo = 0, hi = count
        while lo < hi {
            let mid = (lo + hi) / 2
            let id = childIndex[parentKey]![mid]
            if (blocks[id]?.sortKey ?? "", id) < key { lo = mid + 1 } else { hi = mid }
        }
        childIndex[parentKey]!.insert(b.id, at: lo)
    }

    private func removeFromIndex(_ id: RecordID, parentKey: String) {
        guard childIndex[parentKey] != nil else { return }
        if let i = childIndex[parentKey]!.lastIndex(of: id) { childIndex[parentKey]!.remove(at: i) }
        if childIndex[parentKey]!.isEmpty { childIndex[parentKey] = nil }
    }
}
