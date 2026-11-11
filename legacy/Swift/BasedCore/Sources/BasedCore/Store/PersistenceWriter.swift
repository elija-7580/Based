import Foundation

/// BSD-42: writes to a `ChangeLogging` persistence on a background serial queue, so a commit on the main thread
/// (every keystroke) only enqueues its records instead of running `BEGIN IMMEDIATE … COMMIT` plus JSON encoding.
///
/// - Order is strictly FIFO: record batches and `setMeta` calls reach the base in the order they were made.
/// - Consecutive record batches that are still waiting are coalesced into one SQLite transaction; a record written
///   several times keeps only its last version (its change-log row is the newest one either way).
/// - Every read (`changes(after:)`, `lastChangeSeq`, `tombstone`, `meta`, `loadAll`, …) first waits until the
///   queue is drained, so readers (sync, server) never see a log without the changes already shown in memory.
///   `meta` answers from a still-pending `setMeta` when writing is stopped by a failure.
/// - A failed write stops the queue: the failed batch and everything after it stay pending (in memory, in order)
///   and `onFailure` is called on the writer's queue. `checkWritable()` (called by `WorkspaceStore.retryWrites`)
///   writes the pending items again and clears the failure when they're all saved. Unlike a synchronous write, the
///   in-memory change can't be rolled back any more: it stays visible and is saved by the retry.
/// - `flush()` / `flushSync(timeout:)` wait for the queue (quit, background, tests).
///
/// Thread safety: the base is only touched on `queue`; the pending list is guarded by `lock`.
public final class PersistenceWriter: ChangeLogging, @unchecked Sendable {
    /// The wrapped persistence (e.g. `SQLitePersistence`). Don't write to it directly while the writer is in use.
    public let base: ChangeLogging

    struct Batch {
        var upserts: [Record]
        var deletions: [RecordKey]
        var tombstones: [RecordKey: Stamp]
        var local: Bool
    }

    enum Item {
        case records(Batch)
        case meta(String, Data?)
    }

    private let queue = DispatchQueue(label: "based.persistence.writer", qos: .userInitiated)
    private let queueKey = DispatchSpecificKey<Bool>()
    private let lock = NSLock()
    private var pending: [Item] = []
    private var draining = false
    private var _failure: Error?
    private var _writtenBatches = 0

    /// Called (on the writer's queue) when a write fails. The writer stays stopped until `checkWritable()` succeeds.
    public var onFailure: (@Sendable (Error) -> Void)? {
        get { lock.withLock { _onFailure } }
        set { lock.withLock { _onFailure = newValue } }
    }
    private var _onFailure: (@Sendable (Error) -> Void)?

    public init(_ base: ChangeLogging) {
        self.base = base
        queue.setSpecific(key: queueKey, value: true)
    }

    /// The error that stopped writing, nil while writes succeed.
    public var failure: Error? { lock.withLock { _failure } }
    /// Items (record batches and meta values) not yet saved.
    public var pendingCount: Int { lock.withLock { pending.count } }
    /// SQLite transactions the writer has run (coalescing makes this smaller than the number of batches).
    public var writtenBatches: Int { lock.withLock { _writtenBatches } }

    /// The underlying `SQLitePersistence`, if there is one.
    public var sqlite: SQLitePersistence? { base as? SQLitePersistence }

    // MARK: Writing

    public func write(upserts: [Record], deletions: [RecordKey]) throws {
        try write(upserts: upserts, deletions: deletions, local: true)
    }

    public func write(upserts: [Record], deletions: [RecordKey], local: Bool) throws {
        try write(upserts: upserts, deletions: deletions, tombstones: [:], local: local)
    }

    /// Enqueues the batch and returns at once. Never throws: failures are reported through `onFailure`/`failure`.
    public func write(upserts: [Record], deletions: [RecordKey], tombstones: [RecordKey: Stamp], local: Bool) throws {
        guard !upserts.isEmpty || !deletions.isEmpty else { return }
        enqueue(.records(Batch(upserts: upserts, deletions: deletions, tombstones: tombstones, local: local)))
    }

    public func setMeta(_ key: String, _ value: Data?) {
        enqueue(.meta(key, value))
    }

    private func enqueue(_ item: Item) {
        let start: Bool = lock.withLock {
            pending.append(item)
            guard !draining, _failure == nil else { return false }
            draining = true
            return true
        }
        if start { queue.async { self.drain() } }
    }

    /// Runs on `queue`: writes pending items until the list is empty or a write fails.
    private func drain() {
        while true {
            let next: (items: [Item], count: Int)? = lock.withLock {
                guard _failure == nil, !pending.isEmpty else { draining = false; return nil }
                return Self.takeRun(pending)
            }
            guard let next else { return }
            do {
                try apply(next.items)
                lock.withLock {
                    pending.removeFirst(next.count)
                    _writtenBatches += 1
                }
            } catch {
                let callback: (@Sendable (Error) -> Void)? = lock.withLock {
                    _failure = error
                    draining = false
                    return _onFailure
                }
                Log.error("Background save failed: \(error) — \(pendingCount) changes kept in memory until a retry",
                          category: "store")
                callback?(error)
                return
            }
        }
    }

    /// The next unit of work from the front of `items`: one meta value, or all consecutive record batches with the
    /// same `local` flag merged into one. Returns the items to apply and how many pending entries they cover.
    static func takeRun(_ items: [Item]) -> (items: [Item], count: Int) {
        guard case .records(let first) = items[0] else { return ([items[0]], 1) }
        var merged = first
        var count = 1
        while count < items.count, case .records(let b) = items[count], b.local == first.local {
            merged = merge(merged, b)
            count += 1
        }
        return ([.records(merged)], count)
    }

    /// `a` then `b` as one batch: each key keeps only its last change.
    static func merge(_ a: Batch, _ b: Batch) -> Batch {
        if a.upserts.isEmpty && a.deletions.isEmpty { return b }
        var upserts: [RecordKey: Record] = [:]
        var order: [RecordKey] = []
        var deleted: [RecordKey: Stamp?] = [:]
        var delOrder: [RecordKey] = []
        func up(_ r: Record) {
            if upserts[r.key] == nil { order.append(r.key) }
            upserts[r.key] = r
            deleted[r.key] = nil
        }
        func del(_ k: RecordKey, _ stamp: Stamp?) {
            upserts[k] = nil
            if deleted[k] == nil { delOrder.append(k) }
            deleted[k] = .some(stamp)
        }
        for r in a.upserts { up(r) }
        for k in a.deletions { del(k, a.tombstones[k]) }
        for r in b.upserts { up(r) }
        for k in b.deletions { del(k, b.tombstones[k]) }
        var out = Batch(upserts: [], deletions: [], tombstones: [:], local: a.local)
        out.upserts = order.compactMap { upserts[$0] }
        for k in delOrder {
            guard let s = deleted[k] else { continue }
            out.deletions.append(k)
            if let s { out.tombstones[k] = s }
        }
        return out
    }

    private func apply(_ items: [Item]) throws {
        for item in items {
            switch item {
            case .records(let b):
                try base.write(upserts: b.upserts, deletions: b.deletions, tombstones: b.tombstones, local: b.local)
            case .meta(let k, let v):
                base.setMeta(k, v)
            }
        }
    }

    // MARK: Waiting

    fileprivate var onQueue: Bool { DispatchQueue.getSpecific(key: queueKey) == true }

    /// Runs `body` on the writer queue after everything enqueued so far has been handled.
    fileprivate func onDrainedQueue<T>(_ body: () throws -> T) rethrows -> T {
        if onQueue { return try body() }
        return try queue.sync { try body() }
    }

    /// Blocks until every change enqueued so far is saved (or writing stopped on a failure).
    /// Returns false if changes are still unsaved because of a failure.
    @discardableResult
    public func flushNow() -> Bool {
        onDrainedQueue { }
        return lock.withLock { pending.isEmpty }
    }

    /// Waits (without blocking a thread) until every change enqueued so far is saved or writing failed.
    @discardableResult
    public func flush() async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            queue.async { c.resume() }
        }
        return lock.withLock { pending.isEmpty }
    }

    /// Blocks at most `timeout` seconds for the queue (app quit / background). Returns true when everything is
    /// saved; false on timeout or when a failure keeps changes unsaved.
    @discardableResult
    public func flushSync(timeout: TimeInterval) -> Bool {
        if onQueue { return lock.withLock { pending.isEmpty } }
        let done = DispatchSemaphore(value: 0)
        queue.async { done.signal() }
        guard done.wait(timeout: .now() + timeout) == .success else {
            Log.warning("Saving on quit timed out after \(timeout) s (\(pendingCount) changes pending)", category: "store")
            return false
        }
        return lock.withLock { pending.isEmpty }
    }

    // MARK: Retry

    /// Checks the base can be written and saves everything that is pending (in order). Clears the failure on
    /// success; throws (and stays stopped) otherwise. `WorkspaceStore.retryWrites()` calls this.
    public func checkWritable() throws {
        try onDrainedQueue {
            try base.checkWritable()
            while true {
                let next: (items: [Item], count: Int)? = lock.withLock {
                    pending.isEmpty ? nil : Self.takeRun(pending)
                }
                guard let next else { break }
                try apply(next.items)
                lock.withLock {
                    pending.removeFirst(next.count)
                    _writtenBatches += 1
                }
            }
            lock.withLock { _failure = nil }
        }
    }

    // MARK: Reading (after the queue is drained)

    public func loadAll() throws -> [Record] { try onDrainedQueue { try base.loadAll() } }
    public func loadAllReporting() throws -> LoadResult { try onDrainedQueue { try base.loadAllReporting() } }

    public func meta(_ key: String) -> Data? {
        onDrainedQueue {
            // While stopped by a failure, a meta value may still be pending: the newest pending one wins.
            let pendingValue: Data?? = lock.withLock {
                for item in pending.reversed() { if case .meta(let k, let v) = item, k == key { return .some(v) } }
                return nil
            }
            if let pendingValue { return pendingValue }
            return base.meta(key)
        }
    }

    public func changes(after: Int64, limit: Int) throws -> [ChangeEntry] {
        try onDrainedQueue { try base.changes(after: after, limit: limit) }
    }

    public var lastChangeSeq: Int64 { onDrainedQueue { base.lastChangeSeq } }

    public func tombstone(_ key: RecordKey) -> Stamp? { onDrainedQueue { base.tombstone(key) } }

    public func compactTombstones(olderThanMillis cutoffMillis: Int64) throws -> (removed: Int, maxSeq: Int64) {
        try onDrainedQueue { try base.compactTombstones(olderThanMillis: cutoffMillis) }
    }
}

extension PersistenceWriter {
    /// Meta keys with a prefix, after the queue is drained (see `SQLitePersistence.metaKeys(prefix:)`).
    public func metaKeys(prefix: String) -> [String] { onDrainedQueue { sqlite?.metaKeys(prefix: prefix) ?? [] } }
}

extension Persistence {
    /// The `SQLitePersistence` behind this persistence (directly or behind a `PersistenceWriter`).
    /// Writing to it directly bypasses the writer's queue: call `flushPendingWrites()` first.
    public var sqliteBase: SQLitePersistence? {
        if let s = self as? SQLitePersistence { return s }
        return (self as? PersistenceWriter)?.sqlite
    }

    /// Stored meta keys with a prefix (empty for persistences that can't list them).
    public func storedMetaKeys(prefix: String) -> [String] {
        if let w = self as? PersistenceWriter { return w.metaKeys(prefix: prefix) }
        return (self as? SQLitePersistence)?.metaKeys(prefix: prefix) ?? []
    }

    /// Waits until queued writes are saved (no-op for synchronous persistences). False if some are unsaved.
    @discardableResult
    public func flushPendingWrites() -> Bool { (self as? PersistenceWriter)?.flushNow() ?? true }
}
