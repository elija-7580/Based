import Foundation

// BSD-66: what the Apple Watch app sends to the iPhone, and its outbox while the iPhone is out of reach.
//
// This file is compiled twice: into BasedCore (tests, iPhone app) and directly into the watchOS target
// (project.yml lists it as a source there), so it must only use Foundation.

/// Metadata of one voice note sent with `WCSession.transferFile(_:metadata:)`. The metadata dictionary must be
/// property-list types only, so everything is a String, Double or Int.
public struct WatchCaptureMeta: Equatable, Sendable, Codable {
    public static let currentVersion = 1
    public static let kind = "based.watch.voice"

    /// Stable id: the iPhone ignores a second transfer of the same note (a retry after a lost acknowledgement).
    public var id: String
    public var capturedAt: Date
    /// Seconds of audio.
    public var duration: Double
    /// File extension of the audio ("m4a").
    public var fileExtension: String
    public var version: Int

    public init(id: String = UUID().uuidString, capturedAt: Date, duration: Double, fileExtension: String = "m4a",
                version: Int = WatchCaptureMeta.currentVersion) {
        self.id = id
        self.capturedAt = capturedAt
        self.duration = duration
        self.fileExtension = fileExtension
        self.version = version
    }

    public var dictionary: [String: Any] {
        ["kind": Self.kind, "v": version, "id": id, "at": capturedAt.timeIntervalSince1970, "dur": duration, "ext": fileExtension]
    }

    public enum DecodeError: Error, Equatable { case notAWatchCapture, newerVersion(Int), missing(String) }

    /// Reads metadata sent by any watch app version up to ours; a newer format is refused (the iPhone app is older
    /// than the watch app — it keeps the file until it is updated).
    public init(dictionary d: [String: Any]) throws {
        guard d["kind"] as? String == Self.kind else { throw DecodeError.notAWatchCapture }
        let v = (d["v"] as? Int) ?? (d["v"] as? Double).map(Int.init) ?? 1
        guard v <= Self.currentVersion else { throw DecodeError.newerVersion(v) }
        guard let id = d["id"] as? String, !id.isEmpty else { throw DecodeError.missing("id") }
        guard let at = (d["at"] as? Double) ?? (d["at"] as? Int).map(Double.init) else { throw DecodeError.missing("at") }
        let dur = (d["dur"] as? Double) ?? (d["dur"] as? Int).map(Double.init) ?? 0
        let ext = (d["ext"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "m4a"
        self.init(id: id, capturedAt: Date(timeIntervalSince1970: at), duration: dur, fileExtension: ext, version: v)
    }
}

/// The watch keeps every recording here until the iPhone confirmed the transfer (`WCSessionFileTransfer` finished
/// without error). Survives app restarts: an index file (`outbox.json`) next to the audio files.
public final class WatchOutbox: @unchecked Sendable {
    public struct Item: Equatable, Codable, Sendable {
        public var meta: WatchCaptureMeta
        /// File name inside the outbox folder.
        public var file: String
        /// Transfers started (a transfer that never finishes is started again on the next launch).
        public var attempts: Int
    }

    public let directory: URL
    private let lock = NSLock()
    private var items: [Item] = []

    public init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL), let saved = try? JSONDecoder().decode([Item].self, from: data) {
            // Only items whose audio is still there.
            items = saved.filter { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.file).path) }
        }
    }

    private var indexURL: URL { directory.appendingPathComponent("outbox.json") }

    public var pending: [Item] { lock.withLock { items } }

    public func url(of item: Item) -> URL { directory.appendingPathComponent(item.file) }

    /// Moves a finished recording into the outbox. Recordings shorter than `minimumSeconds` are dropped.
    @discardableResult
    public func enqueue(recording: URL, meta: WatchCaptureMeta, minimumSeconds: Double = 0.7) throws -> Item? {
        guard meta.duration >= minimumSeconds else {
            try? FileManager.default.removeItem(at: recording)
            return nil
        }
        let name = "\(meta.id).\(meta.fileExtension)"
        let dest = directory.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: recording, to: dest)
        let item = Item(meta: meta, file: name, attempts: 0)
        lock.withLock { items.append(item) }
        save()
        return item
    }

    /// Items to (re)send now: everything not yet confirmed whose transfer isn't running (`inFlight` = ids the
    /// session still reports as outstanding).
    public func toSend(inFlight: Set<String>) -> [Item] {
        lock.withLock { items.filter { !inFlight.contains($0.meta.id) } }
    }

    public func markStarted(_ id: String) {
        lock.withLock { if let i = items.firstIndex(where: { $0.meta.id == id }) { items[i].attempts += 1 } }
        save()
    }

    /// The iPhone has the file: delete it here.
    public func markDelivered(_ id: String) {
        let removed: Item? = lock.withLock {
            guard let i = items.firstIndex(where: { $0.meta.id == id }) else { return nil }
            return items.remove(at: i)
        }
        if let removed { try? FileManager.default.removeItem(at: directory.appendingPathComponent(removed.file)) }
        save()
    }

    private func save() {
        let snapshot = lock.withLock { items }
        if let data = try? JSONEncoder().encode(snapshot) { try? data.write(to: indexURL, options: .atomic) }
    }
}

/// What the iPhone tells the watch (application context) and the line the watch shows: "3 today · sorted at 23:00".
public struct WatchStatus: Equatable, Sendable {
    public var capturedToday: Int
    /// "HH:mm" of the nightly sorting run, nil when none is scheduled.
    public var sortTime: String?
    /// Recordings still on the watch.
    public var waiting: Int

    public init(capturedToday: Int, sortTime: String?, waiting: Int = 0) {
        self.capturedToday = capturedToday
        self.sortTime = sortTime
        self.waiting = waiting
    }

    public var context: [String: Any] {
        var d: [String: Any] = ["today": capturedToday]
        if let sortTime { d["sort"] = sortTime }
        return d
    }

    public init(context: [String: Any], waiting: Int = 0) {
        capturedToday = (context["today"] as? Int) ?? 0
        sortTime = context["sort"] as? String
        self.waiting = waiting
    }

    public var line: String {
        var parts = ["\(capturedToday) today"]
        if waiting > 0 { parts.append("\(waiting) waiting for iPhone") }
        if let sortTime { parts.append("sorted at \(sortTime)") }
        return parts.joined(separator: " · ")
    }
}

/// The iPhone side: drops transfers it already turned into captures (a retry after a lost acknowledgement).
public struct WatchInboxLedger: Sendable {
    public private(set) var seen: [String]
    public var limit = 500
    public init(seen: [String] = []) { self.seen = seen }

    /// True when `id` is new (and remembers it).
    public mutating func accept(_ id: String) -> Bool {
        guard !seen.contains(id) else { return false }
        seen.append(id)
        if seen.count > limit { seen.removeFirst(seen.count - limit) }
        return true
    }
}
