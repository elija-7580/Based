import Foundation
import BasedCore

// MARK: - Memory suggestions from chats (BSD-59)
//
// After a chat turn a small model reads the last exchange plus the titles of the existing memories and proposes at
// most three new or extended memories. Each proposal becomes an Inbox item of kind "Memory" (Save · Dismiss; the
// item's page can be edited before saving). Nothing is written to Memories until the user confirms in the app or on
// the server — agents cannot accept a suggestion through `answer_inbox`, and sensitive topics (health, money) are
// flagged as such. A proposal whose title matches an existing memory extends that memory instead of adding one.

/// One proposed memory.
public struct MemorySuggestion: Sendable, Equatable {
    public var title: String
    public var kind: Memory.Kind
    public var body: String
    /// The existing memory this extends (similar title), nil = a new memory.
    public var updates: RecordID?
    /// Health, money and the like: never saved without an explicit confirmation (and marked in the Inbox).
    public var sensitive: Bool

    public init(title: String, kind: Memory.Kind = .Notes, body: String, updates: RecordID? = nil, sensitive: Bool = false) {
        self.title = title; self.kind = kind; self.body = body; self.updates = updates; self.sensitive = sensitive
    }

    /// The Inbox item's page: a few header lines the app shows and `parse` reads back, then the memory's text.
    /// The user may edit the page before saving; the edited text is what gets saved.
    public var detail: String {
        var lines = ["Memory: \(title)", "Type: \(kind.rawValue)"]
        if let updates { lines.append("Updates: \(updates)") }
        if sensitive { lines.append("Sensitive: yes — saved only if you confirm") }
        return lines.joined(separator: "\n\n") + "\n\n---\n\n" + body
    }

    /// Reads `detail` back (also after the user edited the page). nil when the header is gone.
    public static func parse(detail: String) -> MemorySuggestion? {
        let parts = detail.components(separatedBy: "\n---\n")
        guard parts.count >= 2 else { return nil }
        var title = "", kind = Memory.Kind.Notes, updates: RecordID?, sensitive = false
        for raw in parts[0].components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            func value(_ key: String) -> String? {
                line.hasPrefix(key) ? String(line.dropFirst(key.count)).trimmingCharacters(in: .whitespaces) : nil
            }
            if let v = value("Memory:") { title = v }
            else if let v = value("Type:") { kind = Memory.Kind(rawValue: v) ?? .Notes }
            else if let v = value("Updates:"), !v.isEmpty { updates = v }
            else if value("Sensitive:") != nil { sensitive = true }
        }
        let body = parts.dropFirst().joined(separator: "\n---\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !body.isEmpty else { return nil }
        return MemorySuggestion(title: title, kind: kind, body: body, updates: updates, sensitive: sensitive)
    }
}

/// Builds the extraction prompt and reads the model's answer (pure; the model call is in `AgentRuntime`).
public enum MemoryExtractor {
    public static let maxSuggestions = 3
    /// Shorter exchanges carry nothing worth remembering ("thanks", "go on").
    public static let minUserChars = 20

    public static let system = """
    You maintain the user's long-term memories for a notes app. From the conversation excerpt, extract only durable \
    facts the USER stated about themselves, their projects, people they work with or their preferences — nothing the \
    assistant said, nothing about the current task only, nothing already in the existing memories. One topic per \
    memory; title the topic, not the fact (e.g. "Writing style", "Project Based"). Reuse an existing title when the \
    fact extends it. Mark health, medical, financial, legal or similarly private facts with "sensitive": true. \
    At most 3. Reply with JSON only: {"memories": [{"title": "…", "type": "Profile|Preference|Work|People|Notes", \
    "body": "one or two sentences", "sensitive": false}]} — or {"memories": []} when there is nothing.
    """

    /// The last exchange of a transcript: from the last "**You**" entry on (the whole text when there is none).
    public static func lastExchange(_ transcript: String, limit: Int = 6000) -> (user: String, exchange: String) {
        let marker = "**You**"
        guard let r = transcript.range(of: marker, options: .backwards) else { return ("", String(transcript.suffix(limit))) }
        let exchange = String(transcript[r.lowerBound...])
        let afterYou = exchange.dropFirst(marker.count)
        let user = afterYou.components(separatedBy: "\n**").first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (user, String(exchange.prefix(limit)))
    }

    public static func prompt(exchange: String, existing: [Memory]) -> String {
        let titles = existing.prefix(60).map { "- \($0.title) (\($0.kind.rawValue))" }.joined(separator: "\n")
        return "Existing memories:\n\(titles.isEmpty ? "(none)" : titles)\n\nConversation:\n\(exchange)"
    }

    /// The model's JSON (possibly fenced or with text around it) → at most three suggestions. Titles similar to an
    /// existing memory become updates of it; suggestions whose text is already in that memory are dropped.
    public static func parse(_ answer: String, existing: [Memory]) -> [MemorySuggestion] {
        guard let start = answer.firstIndex(where: { $0 == "{" || $0 == "[" }),
              let end = answer.lastIndex(where: { $0 == "}" || $0 == "]" }), start < end,
              let v = try? JSONValue.parse(String(answer[start...end])) else { return [] }
        let items = v["memories"]?.array ?? v.array ?? []
        var out: [MemorySuggestion] = []
        for item in items {
            guard let title = item["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty,
                  let body = item["body"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty else { continue }
            let kind = Memory.Kind.allCases.first { $0.rawValue.caseInsensitiveCompare(item["type"]?.string ?? "") == .orderedSame } ?? .Notes
            var s = MemorySuggestion(title: String(title.prefix(80)), kind: kind, body: String(body.prefix(1000)),
                                     sensitive: item["sensitive"]?.bool == true || looksSensitive(title + " " + body))
            if let match = existing.first(where: { similar($0.title, s.title) }) {
                if normalized(match.body).contains(normalized(s.body)) { continue }
                s.updates = match.id; s.title = match.title; s.kind = match.kind
            }
            if out.contains(where: { similar($0.title, s.title) }) { continue }
            out.append(s)
            if out.count == maxSuggestions { break }
        }
        return out
    }

    static func normalized(_ s: String) -> String {
        s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Same topic: equal after normalising, one contained in the other, or most words shared.
    public static func similar(_ a: String, _ b: String) -> Bool {
        let x = normalized(a), y = normalized(b)
        guard !x.isEmpty, !y.isEmpty else { return false }
        if x == y || (min(x.count, y.count) >= 4 && (x.contains(y) || y.contains(x))) { return true }
        let wa = Set(x.split(separator: " ")), wb = Set(y.split(separator: " "))
        return Double(wa.intersection(wb).count) / Double(wa.union(wb).count) >= 0.6
    }

    private static let sensitiveWords = ["health", "medical", "diagnos", "illness", "therapy", "medication", "doctor",
                                         "salary", "debt", "bank account", "income", "finances", "pregnan",
                                         "gesundheit", "krank", "therapie", "medikament", "diagnose", "arzt",
                                         "gehalt", "schulden", "einkommen", "finanzen", "kontostand"]
    public static func looksSensitive(_ text: String) -> Bool {
        let t = text.lowercased()
        return sensitiveWords.contains { t.contains($0) }
    }
}

@MainActor
extension BrainStore {
    public nonisolated static let memorySaveOption = "save_memory"
    public nonisolated static let memoryDismissOption = "dismiss_memory"

    /// Open memory suggestions (pending Inbox items of kind Memory).
    public func pendingMemorySuggestions() -> [InboxItem] { inbox(pendingOnly: true).filter { $0.kind == .memory } }

    /// Adds the suggestions to the Inbox, skipping ones an open suggestion already covers. Saves nothing.
    @discardableResult
    public func proposeMemories(_ suggestions: [MemorySuggestion], session: RecordID?) -> [RecordID] {
        let open = pendingMemorySuggestions().compactMap { MemorySuggestion.parse(detail: $0.detail) }
        var ids: [RecordID] = []
        for s in suggestions.prefix(MemoryExtractor.maxSuggestions) where !open.contains(where: { MemoryExtractor.similar($0.title, s.title) && $0.body == s.body }) {
            let title = (s.updates == nil ? "Remember: " : "Update memory: ") + s.title
            ids.append(addInbox(title: title, kind: .memory, sessionID: session, detail: s.detail,
                                options: [(Self.memorySaveOption, "Save memory"), (Self.memoryDismissOption, "Dismiss")]))
        }
        return ids
    }

    /// The user's answer to a memory suggestion. Saving reads the item's page as it is now (edits included), or
    /// `edited` when the app passes changed text. First answer wins (`resolveInbox`). Returns the memory saved.
    @discardableResult
    public func answerMemorySuggestion(_ id: RecordID, save: Bool, edited: MemorySuggestion? = nil, device: String? = nil) -> RecordID? {
        guard let item = inbox().first(where: { $0.id == id }), item.kind == .memory, item.status == .pending else { return nil }
        guard save else {
            resolveInbox(id, decision: Self.memoryDismissOption, status: .rejected, device: device)
            return nil
        }
        guard let s = edited ?? MemorySuggestion.parse(detail: item.detail),
              resolveInbox(id, decision: Self.memorySaveOption, status: .approved, device: device) else { return nil }
        if let target = s.updates, memories().contains(where: { $0.id == target }) {
            appendBody(target, markdown: s.body)
            return target
        }
        return saveMemory(title: s.title, kind: s.kind, body: s.body)
    }
}

extension AgentRuntime {
    /// Reads the last exchange of `session`, asks `modelRef` (a small model is enough) for memory suggestions and
    /// puts them in the Inbox. Encrypted chats and short messages are skipped. Never saves a memory.
    @discardableResult
    public func suggestMemories(session: RecordID, modelRef: String?) async -> [RecordID] {
        let brain = tools.brain
        let (transcript, existing) = await MainActor.run { (brain.transcript(session), brain.memories()) }
        guard !transcript.contains("```based-encrypted") else { return [] }
        let (user, exchange) = MemoryExtractor.lastExchange(transcript)
        guard user.count >= MemoryExtractor.minUserChars, let (provider, model) = registry.resolve(modelRef ?? "") else { return [] }
        let messages = [ChatMessage(role: .system, content: MemoryExtractor.system),
                        ChatMessage(role: .user, content: MemoryExtractor.prompt(exchange: exchange, existing: existing))]
        guard let r = try? await provider.complete(messages, model: model, tools: [], maxTokens: 600) else { return [] }
        let suggestions = MemoryExtractor.parse(r.message.content, existing: existing)
        guard !suggestions.isEmpty else { return [] }
        return await MainActor.run { brain.proposeMemories(suggestions, session: session) }
    }
}
