// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import Foundation

// BSD-66: what the Apple Watch app sends to the iPhone, and its outbox while the iPhone is out of reach.
// Taken over from legacy/Swift/BasedCore/Sources/BasedCore/Watch/WatchCaptureTransfer.swift (same format, version 1);
// new here: dictated text notes travel the same way as a small text file (`fileExtension` "txt").
//
// Only Foundation, so the tests run with `swift test` (Package.swift) without a watch.
// The iPhone side reads the same metadata in apps/mobile/src-tauri/plugins/watch/ios/Sources/WatchPlugin.swift.

/// Metadata of one note sent with `WCSession.transferFile(_:metadata:)`. The metadata dictionary must be
/// property-list types only, so everything is a String, Double or Int.
public struct WatchCaptureMeta: Equatable, Sendable, Codable {
    public static let currentVersion = 1
    public static let kind = "based.watch.voice"
    public static let textExtension = "txt"

    /// Stable id: the iPhone ignores a second transfer of the same note (a retry after a lost acknowledgement).
    public var id: String
    public var capturedAt: Date
    /// Seconds of audio (0 for a text note).
    public var duration: Double
    /// File extension: "m4a" for a voice note, "txt" for a dictated note.
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

    public var isText: Bool { fileExtension == Self.textExtension }

    public var dictionary: [String: Any] {
        ["kind": Self.kind, "v": version, "id": id, "at": capturedAt.timeIntervalSince1970, "dur": duration, "ext": fileExtension]
    }

    public enum DecodeError: Error, Equatable { case notAWatchCapture, newerVersion(Int), missing(String) }

    /// Reads metadata sent by any watch app version up to ours; a newer format is refused (the iPhone app is older
    /// than the watch app — it keeps the file until it is updated).
    public init(dictionary d: [String: Any]) throws {
        guard d["kind"] as? String == Self.kind else { throw DecodeError.notAWatchCapture }
        let v = (d["v"] as? Int) ?? (d["v"] as? Double).map { Int($0) } ?? 1
        guard v <= Self.currentVersion else { throw DecodeError.newerVersion(v) }
        guard let id = d["id"] as? String, !id.isEmpty else { throw DecodeError.missing("id") }
        guard let at = (d["at"] as? Double) ?? (d["at"] as? Int).map({ Double($0) }) else { throw DecodeError.missing("at") }
        let dur = (d["dur"] as? Double) ?? (d["dur"] as? Int).map { Double($0) } ?? 0
        let ext = (d["ext"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "m4a"
        self.init(id: id, capturedAt: Date(timeIntervalSince1970: at), duration: dur, fileExtension: ext, version: v)
    }
}

/// The watch keeps every note here until the iPhone confirmed the transfer (`WCSessionFileTransfer` finished
/// without error). Survives app restarts: an index file (`outbox.json`) next to the files.
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
            // Only items whose file is still there.
            items = saved.filter { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.file).path) }
        }
    }

    private var indexURL: URL { directory.appendingPathComponent("outbox.json") }

    public var pending: [Item] { lock.lock(); defer { lock.unlock() }; return items }

    public func url(of item: Item) -> URL { directory.appendingPathComponent(item.file) }

    /// Moves a finished recording into the outbox. Recordings shorter than `minimumSeconds` are dropped
    /// (an accidental tap).
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
        return add(Item(meta: meta, file: name, attempts: 0))
    }

    /// Puts a dictated note into the outbox as a small UTF-8 file. Empty text is dropped.
    @discardableResult
    public func enqueue(text: String, id: String = UUID().uuidString, capturedAt: Date = Date()) throws -> Item? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let meta = WatchCaptureMeta(id: id, capturedAt: capturedAt, duration: 0, fileExtension: WatchCaptureMeta.textExtension)
        let name = "\(meta.id).\(meta.fileExtension)"
        try Data(clean.utf8).write(to: directory.appendingPathComponent(name), options: .atomic)
        return add(Item(meta: meta, file: name, attempts: 0))
    }

    private func add(_ item: Item) -> Item {
        lock.lock()
        items.append(item)
        lock.unlock()
        save()
        return item
    }

    /// Items to (re)send now: everything not yet confirmed whose transfer isn't running (`inFlight` = ids the
    /// session still reports as outstanding).
    public func toSend(inFlight: Set<String>) -> [Item] {
        lock.lock(); defer { lock.unlock() }
        return items.filter { !inFlight.contains($0.meta.id) }
    }

    public func markStarted(_ id: String) {
        lock.lock()
        if let i = items.firstIndex(where: { $0.meta.id == id }) { items[i].attempts += 1 }
        lock.unlock()
        save()
    }

    /// The iPhone has the file: delete it here.
    public func markDelivered(_ id: String) {
        lock.lock()
        let removed: Item? = items.firstIndex(where: { $0.meta.id == id }).map { items.remove(at: $0) }
        lock.unlock()
        if let removed { try? FileManager.default.removeItem(at: directory.appendingPathComponent(removed.file)) }
        save()
    }

    private func save() {
        let snapshot = pending
        if let data = try? JSONEncoder().encode(snapshot) { try? data.write(to: indexURL, options: .atomic) }
    }
}

/// Counts the notes of the current day for the line under the button ("3 today"). The day is the watch's own
/// calendar day; the count starts again when the day changes.
public struct WatchDayCount: Equatable, Codable, Sendable {
    public var day: String
    public var count: Int

    public init(day: String = "", count: Int = 0) {
        self.day = day
        self.count = count
    }

    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The count for `date`'s day (0 when the stored day is another one).
    public func today(_ date: Date = Date(), calendar: Calendar = .current) -> Int {
        day == Self.dayKey(date, calendar: calendar) ? count : 0
    }

    public mutating func add(_ date: Date = Date(), calendar: Calendar = .current) {
        let key = Self.dayKey(date, calendar: calendar)
        if day != key { day = key; count = 0 }
        count += 1
    }
}

/// The line the watch shows under the button: "3 today · 1 waiting for iPhone".
public func watchStatusLine(today: Int, waiting: Int) -> String {
    var parts: [String] = []
    if today > 0 { parts.append("\(today) today") }
    if waiting > 0 { parts.append("\(waiting) waiting for iPhone") }
    return parts.isEmpty ? "Notes go to Based on your iPhone" : parts.joined(separator: " · ")
}
