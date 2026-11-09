import Foundation
import BasedCore

// BSD-11: hand-over between the app and its extensions through the App Group container
// (group.<bundle id>/ShareInbox and group.<bundle id>/widget.json). Extensions never open the workspace: the Share
// extension drops what was shared as a small JSON file, the app files it into Captures (source Share); the app
// writes a snapshot that the widgets read.

/// One thing shared with Based (Share sheet on iPhone/Mac).
public struct SharedItem: Codable, Equatable, Sendable {
    public static let currentVersion = 1
    public var version: Int
    public var id: String
    public var text: String
    public var link: String?
    /// Title of the shared page (Safari passes it), used when there's no text.
    public var pageTitle: String?
    public var sharedAt: Date

    public init(id: String = UUID().uuidString, text: String = "", link: String? = nil, pageTitle: String? = nil, sharedAt: Date = Date()) {
        self.version = Self.currentVersion
        self.id = id; self.text = text; self.link = link; self.pageTitle = pageTitle; self.sharedAt = sharedAt
    }

    /// What lands in Captures: the comment/text, else the page title; the link as link.
    public var captureInput: CaptureInput {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return CaptureInput(text: t.isEmpty ? (pageTitle ?? "") : t, link: link, source: .share, capturedAt: sharedAt)
    }
}

/// A folder of `SharedItem` JSON files (one per share, so the extension and the app never write the same file).
public struct ShareInbox: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }

    /// Called by the Share extension.
    @discardableResult
    public func drop(_ item: SharedItem) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("\(item.id).json")
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        try e.encode(item).write(to: url, options: .atomic)
        return url
    }

    public struct DrainReport: Equatable, Sendable {
        public var filed: [RecordID] = []
        /// Files that couldn't be read or were refused (kept as `.bad` for diagnosis, never retried).
        public var rejected = 0
    }

    /// Files every waiting item into Captures (oldest first) and removes its file. Items from a newer app version
    /// stay until this app is updated.
    @MainActor
    public func drain(into brain: BrainStore) -> DrainReport {
        var report = DrainReport()
        let files = ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        var items: [(URL, SharedItem)] = []
        for f in files {
            guard let data = try? Data(contentsOf: f), let item = try? d.decode(SharedItem.self, from: data) else {
                quarantine(f); report.rejected += 1; continue
            }
            if item.version > SharedItem.currentVersion { continue }
            items.append((f, item))
        }
        for (f, item) in items.sorted(by: { $0.1.sharedAt < $1.1.sharedAt }) {
            do {
                report.filed.append(try brain.addCapture(item.captureInput))
                try? FileManager.default.removeItem(at: f)
            } catch {
                quarantine(f); report.rejected += 1
            }
        }
        return report
    }

    private func quarantine(_ f: URL) {
        try? FileManager.default.moveItem(at: f, to: f.deletingPathExtension().appendingPathExtension("bad"))
    }
}

/// What the widgets show (written by the app whenever it changes, read by the widget extension).
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Line: Codable, Equatable, Sendable {
        public var title: String
        public var detail: String
        public init(title: String, detail: String) { self.title = title; self.detail = detail }
    }
    /// "Running now": agent runs in progress.
    public var running: Int
    public var runningTop: [Line]
    /// "Needs you": open inbox items (approvals, questions) and runs waiting for the user.
    public var needsYou: Int
    public var needsYouTop: [Line]
    public var capturesToday: Int
    public var updatedAt: Date

    public static let empty = WidgetSnapshot(running: 0, runningTop: [], needsYou: 0, needsYouTop: [], capturesToday: 0, updatedAt: .distantPast)

    @MainActor
    public static func make(brain: BrainStore, now: Date = Date(), calendar: Calendar = .current, top: Int = 3) -> WidgetSnapshot {
        let running = brain.runs(RunFilter(statuses: [.running, .waiting]))
        let waitingRuns = brain.runs(RunFilter(statuses: [.needsYou]))
        let inbox = brain.inbox(pendingOnly: true)
        let needs = inbox.map { Line(title: $0.title, detail: $0.kind.rawValue) } + waitingRuns.map { Line(title: $0.title, detail: "Run") }
        let today = brain.captures().filter { calendar.isDate($0.capturedAt, inSameDayAs: now) }.count
        return WidgetSnapshot(running: running.count,
                              runningTop: running.sorted { $0.startedAt > $1.startedAt }.prefix(top).map { Line(title: $0.title, detail: $0.result) },
                              needsYou: needs.count, needsYouTop: Array(needs.prefix(top)), capturesToday: today, updatedAt: now)
    }

    public func encoded() throws -> Data {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        e.outputFormatting = [.sortedKeys]
        return try e.encode(self)
    }

    /// Missing or unreadable → `.empty` (the widget shows zeros instead of failing).
    public static func decode(_ data: Data?) -> WidgetSnapshot {
        guard let data else { return .empty }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return (try? d.decode(WidgetSnapshot.self, from: data)) ?? .empty
    }

    /// Same content apart from the time stamp (the app skips rewriting the file and reloading widgets).
    public func sameContent(as other: WidgetSnapshot) -> Bool {
        var a = self, b = other
        a.updatedAt = .distantPast; b.updatedAt = .distantPast
        return a == b
    }
}
