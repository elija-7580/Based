import Foundation

/// The plain-text report behind "Copy logs" (Diagnostics, Help menu, crash notice): compact,
/// sectioned and readable when pasted into a chat, issue or e-mail — facts first, then the
/// previous run, hangs with the main thread's stack, breadcrumbs and the latest log lines.
public struct DiagnosticReport: Sendable {
    public struct Fact: Sendable, Hashable {
        public var label: String
        public var value: String
        public init(_ label: String, _ value: String) { self.label = label; self.value = value }
    }

    public struct Hang: Sendable, Hashable {
        public var date: Date
        public var milliseconds: Int
        public var breadcrumbs: [String]
        /// Main-thread stack sampled while it was blocked (innermost first; empty if not sampled).
        public var frames: [StackFrame]
        public var samples: Int
        public init(date: Date, milliseconds: Int, breadcrumbs: [String], frames: [StackFrame] = [], samples: Int = 0) {
            self.date = date; self.milliseconds = milliseconds; self.breadcrumbs = breadcrumbs; self.frames = frames; self.samples = samples
        }
    }

    public struct PreviousRun: Sendable, Hashable {
        public var summary: String
        public var breadcrumbs: [String]
        public var crashText: String?
        /// Stack of a hang that was still going on when the run ended (frozen → force quit).
        public var hangFrames: [String]
        /// Last log lines written by that run.
        public var logTail: [LogEntry]
        public init(summary: String, breadcrumbs: [String] = [], crashText: String? = nil, hangFrames: [String] = [], logTail: [LogEntry] = []) {
            self.summary = summary; self.breadcrumbs = breadcrumbs; self.crashText = crashText; self.hangFrames = hangFrames; self.logTail = logTail
        }
    }

    public var title = "Based diagnostic report"
    public var created = Date()
    public var facts: [Fact] = []
    public var previousRun: PreviousRun?
    public var hangs: [Hang] = []
    public var breadcrumbs: [String] = []
    public var entries: [LogEntry] = []
    /// e.g. "last 200 entries, info and above".
    public var entriesNote = ""

    public init() {}

    /// Metadata keys left out of log lines (shown in their own sections already).
    public static let redundantMetadata: Set<String> = ["breadcrumbs", "stack"]

    public func render(maxHangs: Int = 5, framesPerHang: Int = 30, maxBreadcrumbs: Int = 20) -> String {
        var out: [String] = []
        out.append("\(title) — \(Self.stamp.string(from: created))")
        let width = min(16, (facts.map(\.label.count).max() ?? 0) + 2)
        for f in facts { out.append(f.label.padding(toLength: max(width, f.label.count + 1), withPad: " ", startingAt: 0) + f.value) }

        if let p = previousRun {
            out.append("")
            out.append("PREVIOUS RUN")
            out.append("  " + p.summary)
            if let c = p.crashText?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty, c != p.summary {
                for l in c.split(separator: "\n", omittingEmptySubsequences: false).prefix(40) { out.append("    " + l) }
            }
            if !p.hangFrames.isEmpty {
                out.append("  Main thread at the time:")
                for (i, f) in p.hangFrames.prefix(framesPerHang).enumerated() { out.append("    " + Self.index(i) + f) }
            }
            if !p.breadcrumbs.isEmpty {
                out.append("  Last actions:")
                for b in p.breadcrumbs.suffix(10) { out.append("    " + b) }
            }
            if !p.logTail.isEmpty {
                out.append("  Last log lines:")
                for e in p.logTail.suffix(15) { out.append("    " + e.compactLine()) }
            }
        }

        out.append("")
        if hangs.isEmpty {
            out.append("HANGS: none this session")
        } else {
            let longest = hangs.map(\.milliseconds).max() ?? 0
            out.append("HANGS (\(hangs.count) this session, longest \(longest) ms — newest first)")
            for h in hangs.suffix(maxHangs).reversed() {
                let after = h.breadcrumbs.last.map { "  after: " + Self.dropStamp($0) } ?? ""
                out.append("  \(Self.time.string(from: h.date))  \(h.milliseconds) ms\(after)")
                if h.frames.isEmpty {
                    out.append("    (no stack sample)")
                } else {
                    if let c = StackSymbols.culprit(h.frames), c != h.frames.first { out.append("    in: " + (c.symbol ?? c.line)) }
                    for (i, f) in h.frames.prefix(framesPerHang).enumerated() { out.append("    " + Self.index(i) + f.line) }
                    if h.frames.count > framesPerHang { out.append("    … \(h.frames.count - framesPerHang) more frames") }
                }
            }
            if hangs.count > maxHangs { out.append("  … \(hangs.count - maxHangs) older hangs") }
        }

        if !breadcrumbs.isEmpty {
            out.append("")
            out.append("BREADCRUMBS (last \(min(maxBreadcrumbs, breadcrumbs.count)))")
            for b in breadcrumbs.suffix(maxBreadcrumbs) { out.append("  " + b) }
        }

        out.append("")
        out.append("LOG" + (entriesNote.isEmpty ? "" : " (\(entriesNote))"))
        if entries.isEmpty { out.append("  (no entries)") }
        for e in entries { out.append(e.compactLine()) }
        return out.joined(separator: "\n") + "\n"
    }

    private static func index(_ i: Int) -> String { (i < 10 ? " \(i)" : "\(i)") + "  " }

    /// "15:35:29.517 navigate → X" → "navigate → X"
    static func dropStamp(_ crumb: String) -> String {
        let parts = crumb.split(separator: " ", maxSplits: 1)
        guard parts.count == 2, parts[0].contains(":") else { return crumb }
        return String(parts[1])
    }

    static let stamp: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; return f
    }()
    static let time: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm:ss"; return f
    }()
    static let shortTime: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm:ss.SSS"; return f
    }()
}

public extension LogEntry {
    /// One line without the date and without metadata that has its own report section:
    /// `15:35:29.517 ▲ hang     Hang: main thread blocked 524 ms ms=524`
    func compactLine(omitting keys: Set<String> = DiagnosticReport.redundantMetadata) -> String {
        let cat = category.count < 8 ? category.padding(toLength: 8, withPad: " ", startingAt: 0) : category
        var s = "\(DiagnosticReport.shortTime.string(from: date)) \(level.symbol) \(cat) "
        let msg = message.replacingOccurrences(of: "\n", with: "\n    ")
        s += msg
        if let metadata {
            let kept = metadata.filter { !keys.contains($0.key) }.sorted { $0.key < $1.key }
            if !kept.isEmpty { s += "  " + kept.map { "\($0.key)=\($0.value)" }.joined(separator: " ") }
        }
        return s
    }
}
