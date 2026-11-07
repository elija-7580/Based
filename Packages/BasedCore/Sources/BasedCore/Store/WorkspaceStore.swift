import Foundation

public enum ChangeOrigin: Sendable { case local, undo, redo, remote, load }

/// What changed in one committed transaction.
public struct ChangeSet: Sendable {
    public var keys: Set<RecordKey> = []
    /// Parent keys (`ParentRef.key`) whose child lists changed.
    public var parents: Set<String> = []
    public var origin: ChangeOrigin

    public var isEmpty: Bool { keys.isEmpty && parents.isEmpty }
    public var blockIDs: [RecordID] { keys.filter { $0.kind == .block }.map(\.id) }
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
    public private(set) var lastError: Error?
    /// Monotonic counter bumped on every committed change (local, remote, undo). Use as a cache key.
    public private(set) var revision: Int = 0

    /// Called after local, undo and redo commits with the changed keys (sync hook).
    public var onLocalChange: (([RecordKey]) -> Void)?

    private var observers: [UUID: (ChangeSet) -> Void] = [:]
    /// Backlink index (built lazily on first `backlinks(to:)`): block → linked pages, page → linking blocks.
    var linkTargets: [RecordID: Set<RecordID>] = [:]
    var linkSources: [RecordID: Set<RecordID>] = [:]
    var linkIndexBuilt = false
    /// Non-nil while the index is built in the background: blocks changed meanwhile (re-indexed on install).
    var linkIndexPending: Set<RecordID>?
    /// Revision-keyed caches for whole-workspace page lists (Home "Recents", Quick Find, link pickers).
    var recentPagesCache: (revision: Int, limit: Int, pages: [Block])?
    var allPagesCache: (revision: Int, pages: [Block])?
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
        var loadedWorkspace = false
        if let persistence {
            do {
                loadedWorkspace = bulkLoad(try persistence.loadAll())
            } catch {
                lastError = error
            }
        }
        if !loadedWorkspace {
            transact("Create workspace", undoable: false) { tx in tx.put(Workspace()) }
        }
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
    @discardableResult
    public func transact<T>(_ name: String, coalesce: String? = nil, undoable: Bool = true,
                            _ body: (Tx) throws -> T) rethrows -> T {
        let tx = Tx(store: self)
        let start = DispatchTime.now().uptimeNanoseconds
        do {
            let result = try body(tx)
            commit(tx, name: name, coalesce: coalesce, origin: .local, undoable: undoable)
            let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            if ms > slowTransactionThreshold * 1000 {
                Log.warning("Slow transaction “\(name)”: \(Int(ms)) ms, \(tx.order.count) records", category: "store",
                            metadata: ["ms": String(Int(ms)), "records": String(tx.order.count)])
            }
            return result
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

    private func commit(_ tx: Tx, name: String, coalesce: String?, origin: ChangeOrigin, undoable: Bool) {
        var upserts: [Record] = []
        var deletions: [RecordKey] = []
        var change = ChangeSet(origin: origin)
        var before: [RecordKey: Snapshot] = [:]
        var after: [RecordKey: Snapshot] = [:]
        let now = Date()
        let restamp = origin != .remote && origin != .load
        for key in tx.order {
            let prev = tx.before[key]?.value
            guard var cur = record(key) else {
                if prev != nil {
                    deletions.append(key)
                    change.keys.insert(key)
                    before[key] = Snapshot(value: prev)
                    after[key] = Snapshot(value: nil)
                }
                continue
            }
            if cur == prev { continue }
            if restamp {
                cur = stamped(cur, now: now, keepTimes: tx.preserveTimestamps)
                var ignored = Set<String>()
                restore(key, cur, &ignored)
            }
            upserts.append(cur)
            change.keys.insert(key)
            before[key] = Snapshot(value: prev)
            after[key] = Snapshot(value: cur)
        }
        change.parents = tx.parents
        guard !change.isEmpty else { return }

        if let persistence {
            do { try persistence.write(upserts: upserts, deletions: deletions) }
            catch { lastError = error }
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

        if origin == .local || origin == .undo || origin == .redo {
            onLocalChange?(Array(change.keys))
        }
        revision &+= 1
        if linkIndexBuilt { for k in change.keys where k.kind == .block { reindexLinks(k.id) } }
        else if linkIndexPending != nil { for k in change.keys where k.kind == .block { linkIndexPending?.insert(k.id) } }
        let observeStart = DispatchTime.now().uptimeNanoseconds
        for handler in observers.values { handler(change) }
        let observeMs = Double(DispatchTime.now().uptimeNanoseconds - observeStart) / 1_000_000
        if observeMs > slowTransactionThreshold * 1000 {
            Log.warning("Store observers took \(Int(observeMs)) ms for “\(name)”", category: "store")
        }
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

    public func undo() {
        guard let entry = undoStack.popLast() else { return }
        let tx = Tx(store: self)
        for (key, snap) in entry.before { apply(snap.value, key, tx) }
        commit(tx, name: entry.name, coalesce: nil, origin: .undo, undoable: false)
        var redone = entry
        redone.after = entry.after.mapValues { snap in Snapshot(value: snap.value) }
        redoStack.append(redone)
    }

    public func redo() {
        guard let entry = redoStack.popLast() else { return }
        let tx = Tx(store: self)
        for (key, snap) in entry.after { apply(snap.value, key, tx) }
        commit(tx, name: entry.name, coalesce: nil, origin: .redo, undoable: false)
        var again = entry
        again.coalesceKey = nil
        undoStack.append(again)
    }

    private func apply(_ value: Record?, _ key: RecordKey, _ tx: Tx) {
        if let value { tx.put(value) } else { tx.remove(key) }
    }

    // MARK: Remote changes

    /// Merge records from another device (last-writer-wins by stamp).
    /// Returns keys whose local version is newer and should be re-sent.
    @discardableResult
    public func applyRemote(_ records: [Record], deletions: [RecordKey] = []) -> [RecordKey] {
        let tx = Tx(store: self)
        var stale: [RecordKey] = []
        for r in records {
            clock.observe(r.stamp)
            if let local = record(r.key) {
                if local == r { continue }
                if local.stamp > r.stamp { stale.append(r.key); continue }
            }
            tx.put(r)
        }
        for key in deletions { tx.remove(key) }
        commit(tx, name: "Sync", coalesce: nil, origin: .remote, undoable: false)
        return stale
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

    func _setBlock(_ b: Block, _ parents: inout Set<String>) {
        let old = blocks[b.id]
        blocks[b.id] = b
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

    func _setDatabase(_ d: Database) { databases[d.id] = d }

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
                removeFromIndex(old.id, parentKey: old.parent.key)
                parents.insert(old.parent.key)
            }
        case .database:
            databases.removeValue(forKey: key.id)
        case .view:
            if let old = views.removeValue(forKey: key.id) {
                viewIndex[old.blockID]?.removeAll { $0 == old.id }
                parents.insert("b:" + old.blockID)
            }
        case .workspace:
            break
        }
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
                groups[b.parent.key, default: []].append((b.sortKey, b.id))
            case .database(let d): _setDatabase(d)
            case .view(let v): _setView(v, &ignored)
            case .workspace(let w): _setWorkspace(w); loadedWorkspace = true
            }
        }
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
