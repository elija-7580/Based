import Foundation

/// Keeps a conversation inside the model's context window (BSD-47): long chats and the main agent's endless thread
/// are compacted instead of failing with "prompt too long".
///
/// Estimate: characters / 3.5 per message (+ tool-call arguments, + a flat amount per image). At 75 % of the
/// window, in this order until it fits:
/// 1. tool results outside the newest turn — and all but the last 4 inside it — are cut to 1 kB;
/// 2. turns older than the last 6 are condensed into a "So far" summary (cheap model) appended to the system prompt;
///    without a summarizer (or when it fails) they are dropped with a note;
/// 3. still too big (huge pasted texts): the longest older messages are shortened in the middle.
/// The system message and the newest user message are never cut.
public struct ContextBudget: Sendable, Equatable {
    /// Context window in tokens.
    public var window: Int
    /// Compaction starts above this share of the window.
    public var threshold: Double = 0.75
    /// Turns (a user message and everything after it) kept verbatim.
    public var keepTurns = 6
    /// Tool results kept in full inside the current turn.
    public var keepToolResults = 4
    /// Older tool results are cut to this many characters.
    public var toolResultLimit = 1_000
    /// Tokens counted for an image.
    public static let imageTokens = 1_600

    public init(window: Int) { self.window = window }

    /// Budget for a model ("claude-…", "gpt-4.1", "llama3", "on-device"): known families, otherwise a conservative 32k.
    public init(model: String) { self.init(window: Self.window(for: model)) }

    public static func window(for model: String) -> Int {
        let m = model.lowercased()
        let name = m.split(separator: "/").last.map(String.init) ?? m
        if name.contains("on-device") || m.hasPrefix("apple/") { return 4_096 }
        if name.hasPrefix("claude") { return 200_000 }
        if name.hasPrefix("gpt-4.1") { return 1_000_000 }
        if name.hasPrefix("gpt-5") { return 400_000 }
        if name.hasPrefix("o1") || name.hasPrefix("o3") || name.hasPrefix("o4") { return 200_000 }
        if name.hasPrefix("gpt-4o") || name.hasPrefix("gpt-4-turbo") { return 128_000 }
        if name.hasPrefix("gemini") { return 1_000_000 }
        return 32_000
    }

    public var limit: Int { Int(Double(window) * threshold) }

    // MARK: Estimate

    public static func tokens(_ text: String) -> Int { Int((Double(text.count) / 3.5).rounded(.up)) }

    public static func tokens(_ m: ChatMessage) -> Int {
        var n = 4 + tokens(m.content)
        for c in m.toolCalls { n += tokens(c.name) + tokens(c.arguments.text) }
        if let raw = m.rawContent {
            // Thinking blocks are replayed inside a tool loop; images count as a flat amount.
            for b in raw.array ?? [] {
                switch b["type"]?.string {
                case "thinking": n += tokens(b["thinking"]?.string ?? "")
                case "image": n += imageTokens
                default: break
                }
            }
        }
        return n
    }

    public static func tokens(_ messages: [ChatMessage]) -> Int { messages.reduce(0) { $0 + tokens($1) } }

    // MARK: Compaction

    /// What `fit` did (for the notice and the run log).
    public struct Report: Sendable, Equatable {
        public var before = 0
        public var after = 0
        public var shortenedToolResults = 0
        public var summarizedMessages = 0
        public var droppedMessages = 0
        public var shortenedMessages = 0
        public var summary: String?
        public var changed: Bool { shortenedToolResults + summarizedMessages + droppedMessages + shortenedMessages > 0 }
        public var userNotice: String? {
            if summarizedMessages > 0 { return "Older messages were summarized to fit the context window." }
            if droppedMessages > 0 { return "Older messages were left out to fit the context window." }
            if changed { return "Long tool results and messages were shortened to fit the context window." }
            return nil
        }
    }

    /// Summarizes a block of older conversation into a short "so far" text.
    public typealias Summarizer = @Sendable (String) async throws -> String

    /// Returns the messages to send. `force` compacts even below the threshold (after a "too long" error).
    public func fit(_ input: [ChatMessage], summarizer: Summarizer?, force: Bool = false) async -> ([ChatMessage], Report) {
        var r = Report()
        var m = input
        r.before = Self.tokens(m)
        r.after = r.before
        let target = force ? limit / 2 : limit
        guard r.before > target else { return (m, r) }

        // Turn starts: user messages (tool results are role .tool, so a turn includes its whole tool loop).
        let starts = m.indices.filter { m[$0].role == .user }
        let lastStart = starts.last ?? m.count
        let keepFrom = starts.count > keepTurns ? starts[starts.count - keepTurns] : (starts.first ?? m.count)

        // 1. Tool results.
        let currentTools = m.indices.filter { $0 >= lastStart && m[$0].role == .tool }
        let protectedTools = Set(currentTools.suffix(keepToolResults))
        for i in m.indices where m[i].role == .tool && !protectedTools.contains(i) && m[i].content.count > toolResultLimit {
            m[i].content = String(m[i].content.prefix(toolResultLimit)) + "\n[… shortened to fit the context window]"
            r.shortenedToolResults += 1
        }
        r.after = Self.tokens(m)
        guard r.after > target else { return (m, r) }

        // 2. Older turns → summary in the system prompt.
        let systemIndex = m.first?.role == .system ? 0 : nil
        let olderStart = systemIndex == nil ? 0 : 1
        if keepFrom > olderStart {
            let older = Array(m[olderStart..<keepFrom])
            var summary: String?
            if let summarizer {
                let text = older.map { "\($0.role.rawValue): \($0.content)" }.joined(separator: "\n\n")
                // The summarizer gets at most half the window itself.
                let cap = Int(Double(window / 2) * 3.5)
                let input = text.count > cap ? String(text.prefix(cap / 2)) + "\n[…]\n" + String(text.suffix(cap / 2)) : text
                summary = try? await summarizer(input)
                if let s = summary, s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { summary = nil }
            }
            m.removeSubrange(olderStart..<keepFrom)
            let note = summary.map { "# Earlier in this conversation (summary)\n" + $0 }
                ?? "# Earlier in this conversation\n(\(older.count) older messages were left out to fit the context window.)"
            if let si = systemIndex { m[si].content += "\n\n" + note } else { m.insert(.system(note), at: 0) }
            if summary != nil { r.summarizedMessages = older.count; r.summary = summary } else { r.droppedMessages = older.count }
            r.after = Self.tokens(m)
            guard r.after > target else { return (m, r) }
        }

        // 3. Shorten the longest messages (not the system prompt, not the newest user message, not assistant
        //    messages carrying replayed blocks), down to 2000 characters each, longest first.
        let newestUser = m.lastIndex { $0.role == .user }
        var candidates = m.indices.filter { i in
            m[i].role != .system && i != newestUser && m[i].rawContent == nil && m[i].content.count > 2_000
        }
        candidates.sort { m[$0].content.count > m[$1].content.count }
        for i in candidates where Self.tokens(m) > target {
            let c = m[i].content
            let excess = (Self.tokens(m) - target) * 4
            let keep = max(2_000, c.count - excess)
            guard keep < c.count else { continue }
            m[i].content = String(c.prefix(keep / 2)) + "\n[… shortened to fit the context window …]\n" + String(c.suffix(keep / 2))
            r.shortenedMessages += 1
        }
        r.after = Self.tokens(m)
        return (m, r)
    }

    /// The provider said the prompt is too long (HTTP 400 with a context-length message).
    public static func isContextOverflow(_ error: Error) -> Bool {
        guard case AIError.http(let code, let body) = error, code == 400 || code == 413 else { return false }
        let b = body.lowercased()
        return ["prompt is too long", "context_length_exceeded", "maximum context length", "context window", "too many tokens", "input is too long"]
            .contains { b.contains($0) }
    }

    /// A cheaper model of the same provider for summaries (Haiku, mini), else the model itself.
    public static func summaryModel(of provider: AIProvider, fallback: String) -> String {
        provider.models.first { $0.contains("haiku") } ?? provider.models.first { $0.contains("mini") } ?? fallback
    }
}
