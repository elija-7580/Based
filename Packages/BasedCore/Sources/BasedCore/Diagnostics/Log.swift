import Foundation
#if canImport(os)
import os
#endif

public enum LogLevel: Int, Codable, Comparable, CaseIterable, Sendable {
    case debug, info, notice, warning, error, fault

    public static func < (a: LogLevel, b: LogLevel) -> Bool { a.rawValue < b.rawValue }

    public var name: String {
        switch self {
        case .debug: return "debug"
        case .info: return "info"
        case .notice: return "notice"
        case .warning: return "warning"
        case .error: return "error"
        case .fault: return "fault"
        }
    }

    public var symbol: String {
        switch self {
        case .debug: return "·"
        case .info: return "ℹ︎"
        case .notice: return "●"
        case .warning: return "▲"
        case .error: return "✖︎"
        case .fault: return "‼︎"
        }
    }

    public init?(name: String) {
        guard let l = LogLevel.allCases.first(where: { $0.name == name.lowercased() }) else { return nil }
        self = l
    }
}

/// One log line. Encoded as JSON Lines in the log files (same format in app and server).
public struct LogEntry: Codable, Sendable, Identifiable, Hashable {
    public var id: UInt64
    public var date: Date
    public var level: LogLevel
    public var category: String
    public var message: String
    public var metadata: [String: String]?
    public var thread: String?

    enum CodingKeys: String, CodingKey { case id, date = "t", level = "l", category = "c", message = "m", metadata = "md", thread = "th" }

    public var line: String {
        let f = Log.timeFormatter.string(from: date)
        var s = "\(f) \(level.symbol) [\(category)] \(message)"
        if let metadata, !metadata.isEmpty {
            s += " " + metadata.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        }
        return s
    }
}

/// App-wide structured logging: levels + categories, an in-memory ring buffer (for the Diagnostics
/// view and crash/hang reports), rotating JSONL files, `os_log` on Apple platforms, breadcrumbs and
/// timing helpers. Thread-safe; cheap when a level is filtered out (messages are autoclosures).
public final class Log: @unchecked Sendable {
    public static let shared = Log()

    public var minimumLevel: LogLevel {
        get { locked { _minimumLevel } }
        set { locked { _minimumLevel = newValue } }
    }
    /// Also print to stderr (server, tests, Xcode console when os_log is unavailable).
    public var echoToStderr: Bool {
        get { locked { _echo } }
        set { locked { _echo = newValue } }
    }

    private let lock = NSLock()
    private var _minimumLevel: LogLevel = .info
    private var _echo = false
    private var ring: [LogEntry] = []
    private var ringStart = 0
    private let ringCapacity: Int
    private var crumbs: [String] = []
    private var nextID: UInt64 = 1
    private var listeners: [UUID: (LogEntry) -> Void] = [:]
    private let queue = DispatchQueue(label: "based.log.file", qos: .utility)
    private var file: FileHandle?
    private var fileURL: URL?
    private var fileSize: UInt64 = 0
    private var maxFileBytes: UInt64 = 2 << 20
    private var maxFiles = 5
    /// os_log subsystem on Apple platforms.
    public var subsystem = "com.based.app"
    #if canImport(os)
    private var loggers: [String: Logger] = [:]
    #endif

    public init(capacity: Int = 5000) { ringCapacity = capacity }

    @inline(__always) private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601withFractionalSeconds
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601withFractionalSeconds
        return d
    }()

    // MARK: Configuration

    /// Starts writing `<directory>/<name>.log` (JSONL), rotating to `<name>.1.log` … when it grows.
    public func configure(directory: URL, name: String = "based", maxFileBytes: UInt64 = 2 << 20, maxFiles: Int = 5) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name + ".log")
        queue.sync {
            try? file?.close()
            if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
            file = try? FileHandle(forWritingTo: url)
            fileSize = (try? file?.seekToEnd()) ?? 0
            fileURL = url
            self.maxFileBytes = maxFileBytes
            self.maxFiles = max(1, maxFiles)
        }
    }

    public var directory: URL? { queue.sync { fileURL?.deletingLastPathComponent() } }

    /// Current + rotated log files, newest first.
    public var logFiles: [URL] {
        queue.sync {
            guard let u = fileURL else { return [] }
            let base = u.deletingPathExtension().lastPathComponent
            let dir = u.deletingLastPathComponent()
            return [u] + (1..<maxFiles).map { dir.appendingPathComponent("\(base).\($0).log") }
                .filter { FileManager.default.fileExists(atPath: $0.path) }
        }
    }

    /// Waits for pending file writes (tests, before export / exit).
    public func flush() { queue.sync { try? file?.synchronize() } }

    // MARK: Logging

    public func log(_ level: LogLevel, _ message: @autoclosure () -> String, category: String = "app",
                    metadata: [String: String]? = nil) {
        lock.lock()
        guard level >= _minimumLevel else { lock.unlock(); return }
        let entry = LogEntry(id: nextID, date: Date(), level: level, category: category, message: message(),
                             metadata: metadata, thread: Thread.isMainThread ? "main" : nil)
        nextID += 1
        if ring.count < ringCapacity { ring.append(entry) } else { ring[ringStart] = entry; ringStart = (ringStart + 1) % ringCapacity }
        let echo = _echo
        let handlers = Array(listeners.values)
        #if canImport(os)
        let logger = loggers[category] ?? Logger(subsystem: subsystem, category: category)
        loggers[category] = logger
        #endif
        lock.unlock()

        #if canImport(os)
        let text = entry.message
        switch level {
        case .debug: logger.debug("\(text, privacy: .public)")
        case .info: logger.info("\(text, privacy: .public)")
        case .notice: logger.notice("\(text, privacy: .public)")
        case .warning: logger.warning("\(text, privacy: .public)")
        case .error: logger.error("\(text, privacy: .public)")
        case .fault: logger.fault("\(text, privacy: .public)")
        }
        #endif
        if echo { FileHandle.standardError.write(Data((entry.line + "\n").utf8)) }
        write(entry)
        for h in handlers { h(entry) }
    }

    private func write(_ entry: LogEntry) {
        queue.async { [self] in
            guard let file, var data = try? Self.encoder.encode(entry) else { return }
            data.append(0x0A)
            file.write(data)
            fileSize += UInt64(data.count)
            if fileSize > maxFileBytes { rotate() }
        }
    }

    /// based.log → based.1.log → … (oldest dropped). Runs on the file queue.
    private func rotate() {
        guard let u = fileURL else { return }
        try? file?.close()
        let fm = FileManager.default
        let base = u.deletingPathExtension().lastPathComponent
        let dir = u.deletingLastPathComponent()
        func n(_ i: Int) -> URL { i == 0 ? u : dir.appendingPathComponent("\(base).\(i).log") }
        try? fm.removeItem(at: n(maxFiles - 1))
        if maxFiles > 1 { for i in stride(from: maxFiles - 2, through: 0, by: -1) { try? fm.moveItem(at: n(i), to: n(i + 1)) } }
        fm.createFile(atPath: u.path, contents: nil)
        file = try? FileHandle(forWritingTo: u)
        fileSize = 0
    }

    // MARK: Reading

    /// Most recent entries (oldest first), optionally filtered.
    public func recent(limit: Int = 500, minLevel: LogLevel = .debug, category: String? = nil, search: String? = nil) -> [LogEntry] {
        let all: [LogEntry] = locked { Array(ring[ringStart...] + ring[..<ringStart]) }
        var out: [LogEntry] = []
        for e in all.reversed() {
            guard e.level >= minLevel else { continue }
            if let category, e.category != category { continue }
            if let search, !search.isEmpty, !e.message.localizedCaseInsensitiveContains(search), !e.category.localizedCaseInsensitiveContains(search) { continue }
            out.append(e)
            if out.count >= limit { break }
        }
        return out.reversed()
    }

    public var categories: [String] { locked { Array(Set(ring.map(\.category))).sorted() } }

    /// Entries read back from the JSONL files (newest file last), e.g. the previous run's log.
    public static func read(file url: URL) -> [LogEntry] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { try? decoder.decode(LogEntry.self, from: Data($0.utf8)) }
    }

    /// One human-readable text with all log files plus breadcrumbs (for "Export logs…").
    public func exportText(header: String = "") -> String {
        flush()
        var out = header.isEmpty ? "" : header + "\n\n"
        out += "Breadcrumbs:\n" + breadcrumbs.map { "  " + $0 }.joined(separator: "\n") + "\n\n"
        let files = logFiles.reversed()
        if files.isEmpty {
            out += recent(limit: ringCapacity).map(\.line).joined(separator: "\n")
        } else {
            for f in files { out += Self.read(file: f).map(\.line).joined(separator: "\n") + "\n" }
        }
        return out
    }

    // MARK: Listeners

    @discardableResult
    public func addListener(_ handler: @escaping (LogEntry) -> Void) -> UUID {
        let id = UUID()
        locked { listeners[id] = handler }
        return id
    }

    public func removeListener(_ id: UUID) { _ = locked { listeners.removeValue(forKey: id) } }

    // MARK: Breadcrumbs

    /// Short trail of recent user actions ("open page X", "⌘K") attached to hang / crash reports.
    public func breadcrumb(_ s: String) {
        let stamp = Self.timeFormatter.string(from: Date()).suffix(12)
        locked {
            crumbs.append("\(stamp) \(s)")
            if crumbs.count > 60 { crumbs.removeFirst(crumbs.count - 60) }
        }
    }

    public var breadcrumbs: [String] { locked { crumbs } }
}

// MARK: - Static shortcuts

public extension Log {
    static func debug(_ m: @autoclosure () -> String, category: String = "app", metadata: [String: String]? = nil) { shared.log(.debug, m(), category: category, metadata: metadata) }
    static func info(_ m: @autoclosure () -> String, category: String = "app", metadata: [String: String]? = nil) { shared.log(.info, m(), category: category, metadata: metadata) }
    static func notice(_ m: @autoclosure () -> String, category: String = "app", metadata: [String: String]? = nil) { shared.log(.notice, m(), category: category, metadata: metadata) }
    static func warning(_ m: @autoclosure () -> String, category: String = "app", metadata: [String: String]? = nil) { shared.log(.warning, m(), category: category, metadata: metadata) }
    static func error(_ m: @autoclosure () -> String, category: String = "app", metadata: [String: String]? = nil) { shared.log(.error, m(), category: category, metadata: metadata) }
    static func fault(_ m: @autoclosure () -> String, category: String = "app", metadata: [String: String]? = nil) { shared.log(.fault, m(), category: category, metadata: metadata) }
    static func breadcrumb(_ s: String) { shared.breadcrumb(s) }

    /// Times `body`; logs a warning when it takes longer than `warnAfter` seconds (debug otherwise).
    @discardableResult
    static func measure<T>(_ name: String, category: String = "perf", warnAfter: TimeInterval = 0.1, _ body: () throws -> T) rethrows -> T {
        let start = DispatchTime.now().uptimeNanoseconds
        defer {
            let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            if ms >= warnAfter * 1000 {
                shared.log(.warning, "\(name) took \(Int(ms)) ms", category: category, metadata: ["ms": String(Int(ms))])
            } else {
                shared.log(.debug, "\(name) \(String(format: "%.1f", ms)) ms", category: category)
            }
        }
        return try body()
    }
}


extension JSONEncoder.DateEncodingStrategy {
    static var iso8601withFractionalSeconds: JSONEncoder.DateEncodingStrategy {
        .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(LogDate.format(date))
        }
    }
}

extension JSONDecoder.DateDecodingStrategy {
    static var iso8601withFractionalSeconds: JSONDecoder.DateDecodingStrategy {
        .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            guard let d = LogDate.parse(s) else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "bad date \(s)") }
            return d
        }
    }
}

enum LogDate {
    static let lock = NSLock()
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain = ISO8601DateFormatter()
    static func format(_ d: Date) -> String { lock.lock(); defer { lock.unlock() }; return fractional.string(from: d) }
    static func parse(_ s: String) -> Date? { lock.lock(); defer { lock.unlock() }; return fractional.date(from: s) ?? plain.date(from: s) }
}
