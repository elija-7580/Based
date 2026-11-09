import Foundation
import BasedCore

// BSD-63: everything the user jots down quickly (text, voice note, link) lands in the Brain database "Captures".
// Once a day the agent "Sort captures" files each one: onto a project page, as a new page inside a project, as a
// task, as a memory — or asks the user in the Inbox when it is unsure. Voice notes are transcribed on the device that
// recorded them (`setTranscript`); untranscribed audio waits. The filing rules live in `CaptureSorter`, which turns a
// model's plan into actions and applies them, so the whole flow is testable without a model.

public struct Capture: Sendable, Identifiable, Equatable {
    public enum Source: String, CaseIterable, Sendable, Codable {
        case mac = "Mac", iPhone = "iPhone", watch = "Watch", share = "Share", mail = "Mail", agent = "Agent", shortcut = "Shortcut"

        /// Lenient parsing for tool / HTTP / intent input ("iphone", "teilen", "share-sheet" …).
        public static func parse(_ s: String?) -> Source? {
            guard let k = s?.trimmingCharacters(in: .whitespaces).lowercased(), !k.isEmpty else { return nil }
            if let v = allCases.first(where: { $0.rawValue.lowercased() == k }) { return v }
            switch k {
            case "ios", "phone": return .iPhone
            case "macos", "desktop": return .mac
            case "teilen", "share-sheet", "sharesheet", "share_sheet": return .share
            case "email", "e-mail": return .mail
            case "kurzbefehl", "shortcuts", "siri", "action-button": return .shortcut
            case "mcp", "ai": return .agent
            default: return nil
            }
        }
    }
    public enum Status: String, CaseIterable, Sendable {
        case new = "New", transcribed = "Transcribed", filed = "Filed", discarded = "Discarded"
    }
    public var id: RecordID
    public var title: String
    /// Full text (typed text, or the transcript of a voice note).
    public var text: String
    public var link: String?
    public var audio: FileValue?
    public var source: Source
    public var status: Status
    public var capturedAt: Date
    /// Where it was filed (page / row id) once sorted.
    public var targetID: RecordID?
    /// The sorter's note: what it did or why it waits.
    public var note: String

    /// A voice note whose transcript is still missing — the sorter skips it.
    public var needsTranscript: Bool { audio != nil && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// Waiting to be sorted.
    public var isPending: Bool { (status == .new || status == .transcribed) && !needsTranscript }
}

/// Input for a new capture, shared by the `capture` tool, the HTTP endpoint and the iPhone intents (BSD-65).
public struct CaptureInput: Sendable, Equatable {
    public var text: String
    public var link: String?
    public var audio: AssetRef?
    public var transcript: String?
    public var source: Capture.Source
    public var capturedAt: Date

    public init(text: String = "", link: String? = nil, audio: AssetRef? = nil, transcript: String? = nil,
                source: Capture.Source = .mac, capturedAt: Date = Date()) {
        self.text = text; self.link = link; self.audio = audio; self.transcript = transcript
        self.source = source; self.capturedAt = capturedAt
    }

    public enum Problem: Error, Equatable, CustomStringConvertible {
        case empty, tooLong(Int), badLink(String)
        public var description: String {
            switch self {
            case .empty: return "Nothing to capture: give a text, a link or a voice note."
            case .tooLong(let n): return "The text is too long (\(n) characters, at most \(CaptureInput.maxLength))."
            case .badLink(let s): return "Not a web link: \(s)"
            }
        }
    }

    public static let maxLength = 20_000
    /// BSD-113: largest voice note POST /capture accepts (decoded); ~20 minutes of AAC.
    public static let maxAudioBytes = 20 << 20

    /// A safe file name for an uploaded voice note (no paths, default "voice-note.m4a").
    public static func audioFileName(_ raw: String?) -> String {
        let base = (raw ?? "").split(separator: "/").last.map(String.init)?.split(separator: "\\").last.map(String.init) ?? ""
        let cleaned = String(base.filter { $0.isLetter || $0.isNumber || "-_. ".contains($0) }.prefix(80))
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        return cleaned.isEmpty ? "voice-note.m4a" : cleaned
    }

    /// Trims and checks the input: something must be there, the text fits, a link is http(s). A text that is only a
    /// link becomes the link (sharing a URL as text is common on iOS).
    public func normalized() throws -> CaptureInput {
        var c = self
        c.text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        c.transcript = transcript?.trimmingCharacters(in: .whitespacesAndNewlines)
        if c.transcript?.isEmpty == true { c.transcript = nil }
        var l = link?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if l.isEmpty, Self.isWebLink(c.text) { l = c.text; c.text = "" }
        if !l.isEmpty {
            guard Self.isWebLink(l) else { throw Problem.badLink(l) }
            c.link = l
        } else { c.link = nil }
        if c.text.isEmpty, c.link == nil, c.audio == nil, c.transcript == nil { throw Problem.empty }
        let n = c.text.count + (c.transcript?.count ?? 0)
        if n > Self.maxLength { throw Problem.tooLong(n) }
        return c
    }

    static func isWebLink(_ s: String) -> Bool {
        guard !s.contains(where: \.isWhitespace), let u = URL(string: s), let scheme = u.scheme?.lowercased(),
              scheme == "http" || scheme == "https", u.host?.isEmpty == false else { return false }
        return true
    }

    /// From JSON arguments (`{"text": …, "url": …, "source": …}`) — the `capture` tool and `POST /capture`.
    public static func from(json a: JSONValue, defaultSource: Capture.Source) -> CaptureInput {
        CaptureInput(text: a["text"]?.stringValue ?? "", link: a["url"]?.stringValue ?? a["link"]?.stringValue,
                     transcript: a["transcript"]?.stringValue,
                     source: Capture.Source.parse(a["source"]?.string) ?? defaultSource)
    }

    /// Short title: the first line of the text, else the link's host, else "Voice note <time>".
    public static func title(text: String, link: String?, at date: Date) -> String {
        let first = text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        if !first.isEmpty { return first.count > 80 ? String(first.prefix(79)) + "…" : first }
        if let link, let host = URL(string: link)?.host { return "Link: " + host }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm"
        return "Voice note " + f.string(from: date)
    }
}

@MainActor
extension BrainStore {
    static let capturesMetaKey = "brain.captures"
    public static let captureSorterName = "Sort captures"

    enum CaptureCol {
        static let source = "Source", status = "Status", captured = "Captured", link = "Link", audio = "Audio"
        static let target = "Filed to", note = "Note"
    }

    /// Creates the Captures database on first use (or adopts a synced one), adds missing columns and protects it.
    /// On creation it also adds the "Sort captures" agent (daily 23:00) unless an agent of that name exists.
    @discardableResult
    public func ensureCaptures() -> RecordID {
        let (db, created) = ensureBrainDatabase(title: "Captures", metaKey: Self.capturesMetaKey)
        ensureColumn(db, CaptureCol.source, .select) { s in s.options = Capture.Source.allCases.map { SelectOption(name: $0.rawValue) } }
        ensureColumn(db, CaptureCol.status, .select) { s in
            s.options = Capture.Status.allCases.map { st in
                SelectOption(name: st.rawValue, color: st == .new ? .blue : st == .transcribed ? .purple : st == .filed ? .green : .gray)
            }
        }
        ensureColumn(db, CaptureCol.captured, .date)
        ensureColumn(db, CaptureCol.link, .url)
        ensureColumn(db, CaptureCol.audio, .files)
        ensureColumn(db, CaptureCol.target, .text)
        ensureColumn(db, CaptureCol.note, .text)
        if created { ensureCaptureSorter() }
        return db
    }

    var existingCapturesDB: RecordID? { existingBrainDatabase(title: "Captures", metaKey: Self.capturesMetaKey) }
    public var capturesDB: RecordID { ensureCaptures() }

    /// The shipped sorting agent: created once, never overwritten (the user may edit or disable it).
    @discardableResult
    public func ensureCaptureSorter() -> RecordID {
        if let a = agents().first(where: { $0.name == Self.captureSorterName }) { return a.id }
        // BSD-113: sorting is light work — the router's Low level (route Background/Quick, smallest model).
        return saveAgent(name: Self.captureSorterName, instructions: CaptureSorter.agentInstructions, schedule: "daily 23:00", model: "auto:low")
    }

    // MARK: Writing

    /// Stores a capture. Text → status New; a voice note with transcript → Transcribed; without → New (waits for
    /// its transcript). Throws `CaptureInput.Problem` for empty or invalid input.
    @discardableResult
    public func addCapture(_ input: CaptureInput) throws -> RecordID {
        let c = try input.normalized()
        let db = capturesDB
        let full = [c.text, c.transcript ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        let status: Capture.Status = c.audio != nil && c.transcript != nil ? .transcribed : .new
        var values: [String: PropertyValue] = [:]
        if let pid = propID(db, CaptureCol.source), let oid = store.addOption(db, pid, name: c.source.rawValue) { values[pid] = .select(oid) }
        if let pid = propID(db, CaptureCol.status), let oid = store.addOption(db, pid, name: status.rawValue) { values[pid] = .select(oid) }
        if let pid = propID(db, CaptureCol.captured) { values[pid] = .date(DateValue(start: c.capturedAt, includeTime: true)) }
        if let l = c.link, let pid = propID(db, CaptureCol.link) { values[pid] = .url(l) }
        if let a = c.audio, let pid = propID(db, CaptureCol.audio) { values[pid] = .files([FileValue(name: a.name, asset: a)]) }
        let id = store.addRow(to: db, title: RichText(CaptureInput.title(text: full, link: c.link, at: c.capturedAt)), values: values)
        if !full.isEmpty { setBody(id, markdown: full) }
        return id
    }

    /// Adds the transcript of a voice note (on the recording device, or later on the Mac).
    public func setTranscript(_ id: RecordID, _ transcript: String) {
        guard let c = capture(id) else { return }
        let t = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let body = [c.text, t].filter { !$0.isEmpty }.joined(separator: "\n\n")
        setBody(id, markdown: body)
        if c.title.hasPrefix("Voice note ") { store.renamePage(id, to: CaptureInput.title(text: t, link: nil, at: c.capturedAt)) }
        if c.status == .new { setCaptureStatus(id, .transcribed) }
    }

    func setCaptureStatus(_ id: RecordID, _ status: Capture.Status, target: RecordID? = nil, note: String? = nil) {
        let db = capturesDB
        if let pid = propID(db, CaptureCol.status), let oid = store.addOption(db, pid, name: status.rawValue) { store.setValue(id, pid, .select(oid)) }
        if let target, let pid = propID(db, CaptureCol.target) { store.setValue(id, pid, .text(RichText(target))) }
        if let note, let pid = propID(db, CaptureCol.note) { store.setValue(id, pid, note.isEmpty ? nil : .text(RichText(note))) }
    }

    // MARK: Reading

    /// Captures, newest first (optionally only some statuses).
    public func captures(_ statuses: Set<Capture.Status>? = nil) -> [Capture] {
        guard let db = existingCapturesDB else { return [] }
        return store.rows(of: db).map { decodeCapture($0, db) }
            .filter { statuses == nil || statuses!.contains($0.status) }
            .sorted { ($0.capturedAt, $0.id) > ($1.capturedAt, $1.id) }
    }

    /// What the sorter should look at: New/Transcribed with content, oldest first.
    public func pendingCaptures(limit: Int = 50) -> [Capture] {
        Array(captures().filter(\.isPending).reversed().prefix(limit))
    }

    public func capture(_ id: RecordID) -> Capture? {
        guard let db = existingCapturesDB, let row = store.blocks[id], row.trashedAt == nil, case .database(db) = row.parent else { return nil }
        return decodeCapture(row, db)
    }

    private func decodeCapture(_ row: Block, _ db: RecordID) -> Capture {
        func select(_ col: String) -> String? {
            guard let pid = propID(db, col), case .select(let oid)? = row.values[pid] else { return nil }
            return store.databases[db]?.property(pid)?.option(oid)?.name
        }
        var at = row.createdAt
        if let pid = propID(db, CaptureCol.captured), case .date(let d)? = row.values[pid] { at = d.start }
        var link: String?
        if let pid = propID(db, CaptureCol.link), case .url(let u)? = row.values[pid], !u.isEmpty { link = u }
        var audio: FileValue?
        if let pid = propID(db, CaptureCol.audio), case .files(let fs)? = row.values[pid] { audio = fs.first }
        let target = text(row, db, CaptureCol.target)
        return Capture(id: row.id, title: row.title, text: body(of: row.id), link: link, audio: audio,
                       source: Capture.Source(rawValue: select(CaptureCol.source) ?? "") ?? .mac,
                       status: Capture.Status(rawValue: select(CaptureCol.status) ?? "") ?? .new,
                       capturedAt: at, targetID: target.isEmpty ? nil : target, note: text(row, db, CaptureCol.note))
    }
}

// MARK: - Sorting

/// One filing decision for one capture — the shape of the model's plan and of the `file_capture` tool.
public struct CaptureAction: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        /// Append to a project's overview ("Latest updates"). target = project id or name.
        case project
        /// Append to an existing page that belongs to a project. target = page id.
        case page
        /// New page inside a project. target = project id or name, title required.
        case newPage = "new_page"
        /// Row in the user's task database ("Tasks", "To-dos", "Aufgaben" …). title required.
        case task
        /// Save as a memory about the user. title required.
        case memory
        /// Unsure: ask the user in the Inbox, with a suggestion in `note`.
        case ask
        /// Nothing to keep (empty, duplicate, test). Reason in `note`.
        case discard
    }
    public var capture: RecordID
    public var action: Kind
    public var target: String?
    public var title: String?
    /// Text to file (default: the capture's text plus its link).
    public var text: String?
    /// Short reason / suggestion, shown on the capture and in the Inbox.
    public var note: String?

    public init(capture: RecordID, action: Kind, target: String? = nil, title: String? = nil, text: String? = nil, note: String? = nil) {
        self.capture = capture; self.action = action; self.target = target; self.title = title; self.text = text; self.note = note
    }

    /// From tool arguments; nil when `capture_id`/`action` are missing or unknown.
    public static func from(json a: JSONValue) -> CaptureAction? {
        guard let id = (a["capture_id"] ?? a["capture"])?.string, !id.isEmpty,
              let k = a["action"]?.string, let kind = Kind(rawValue: k.lowercased().replacingOccurrences(of: "-", with: "_")) else { return nil }
        return CaptureAction(capture: id, action: kind, target: a["target"]?.stringValue, title: a["title"]?.stringValue,
                             text: a["text"]?.stringValue, note: a["note"]?.stringValue)
    }
}

public struct CaptureOutcome: Sendable, Equatable {
    public enum Result: Sendable, Equatable { case filed(RecordID), asked(RecordID), discarded, skipped(String) }
    public var capture: RecordID
    public var result: Result
    public var message: String
}

/// Turns a plan into actions and applies them. Rules (the agent's permission boundary): edits happen only inside
/// project pages, the task database or Memories; anything else becomes a question in the Inbox. Captures are never
/// deleted — discarded ones keep their content with status Discarded.
@MainActor
public struct CaptureSorter {
    public let brain: BrainStore
    public init(brain: BrainStore) { self.brain = brain }

    static let taskDatabaseNames = ["tasks", "task list", "to-dos", "todos", "to do", "todo", "aufgaben", "action items"]

    public static let agentInstructions = """
    You sort the user's captures (quick notes, voice-note transcripts, links) once a day.

    1. Call `list_captures` to see what is waiting. Call `list_projects` to know the projects.
    2. For each capture decide one action and call `file_capture`:
       - `project`: it belongs to a project → target = project name; it is added to the project's Latest updates.
       - `new_page`: it is substantial enough for its own page in a project → target = project, title.
       - `page`: it extends a specific existing page of a project → target = page id (search first).
       - `task`: it is something to do → title = short imperative. Goes into the user's task database.
       - `memory`: it is a lasting fact or preference about the user → title.
       - `ask`: you are not sure where it belongs → note = your best suggestion. The user decides in the Inbox.
       - `discard`: empty, test or exact duplicate → note = why.
    3. Keep the user's words; fix only obvious transcription errors. Never invent content.
    4. Finish with one short summary: how many filed, asked, discarded.
    """

    /// The prompt for a one-shot plan (used by `run`): captures and projects, answer as a JSON array of actions.
    public func prompt(for captures: [Capture]) -> String {
        var s = "Sort these captures. Answer only with a JSON array; one object per capture: "
        s += #"{"capture": "<id>", "action": "project|new_page|page|task|memory|ask|discard", "target": "…", "title": "…", "note": "…"}"#
        s += "\n\nProjects:\n"
        let ps = brain.projects().filter { $0.status != .done }
        s += ps.isEmpty ? "(none)\n" : ps.map { "- \($0.name)" + ($0.goal.isEmpty ? "" : ": \($0.goal)") }.joined(separator: "\n") + "\n"
        s += "\nCaptures:\n"
        for c in captures {
            s += "- id \(c.id) · \(c.source.rawValue) · \(Self.day(c.capturedAt))\n"
            let t = (c.text + (c.link.map { "\n" + $0 } ?? "")).trimmingCharacters(in: .whitespacesAndNewlines)
            s += t.split(whereSeparator: \.isNewline).map { "  > " + $0 }.joined(separator: "\n") + "\n"
        }
        return s
    }

    /// Parses a model answer: a JSON array of actions, also inside ```json fences or surrounded by prose. Unknown
    /// actions and objects without a capture id are dropped.
    public nonisolated static func parsePlan(_ text: String) -> [CaptureAction] {
        guard let start = text.firstIndex(of: "["), let end = text.lastIndex(of: "]"), start < end,
              let v = try? JSONDecoder().decode(JSONValue.self, from: Data(text[start...end].utf8)),
              let items = v.array else { return [] }
        return items.compactMap(CaptureAction.from(json:))
    }

    /// Applies one action and records the outcome on the capture.
    @discardableResult
    public func apply(_ a: CaptureAction) -> CaptureOutcome {
        guard let c = brain.capture(a.capture) else {
            return CaptureOutcome(capture: a.capture, result: .skipped("unknown"), message: "No capture \(a.capture).")
        }
        guard c.status != .filed, c.status != .discarded else {
            return CaptureOutcome(capture: c.id, result: .skipped("done"), message: "\(c.title) was already \(c.status.rawValue.lowercased()).")
        }
        let content = (a.text?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            ?? [c.text, c.link ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        let note = a.note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        func ask(_ why: String) -> CaptureOutcome {
            let suggestion = note.isEmpty ? why : note
            let item = brain.addInbox(title: "Where should this go? \(c.title)", kind: .review, sessionID: nil,
                                      detail: "> " + content.replacingOccurrences(of: "\n", with: "\n> ") + "\n\nSuggestion: \(suggestion)\n\nCapture: \(PageLink.url(c.id))")
            brain.setCaptureStatus(c.id, c.status, note: "Waiting for you: \(suggestion)")
            return CaptureOutcome(capture: c.id, result: .asked(item), message: "Asked about \(c.title): \(suggestion)")
        }
        func filed(_ target: RecordID, _ what: String) -> CaptureOutcome {
            brain.setCaptureStatus(c.id, .filed, target: target, note: note.isEmpty ? what : "\(what) — \(note)")
            return CaptureOutcome(capture: c.id, result: .filed(target), message: "\(c.title) → \(what)")
        }
        func project(_ key: String?) -> AgentProject? {
            guard let key = key?.trimmingCharacters(in: .whitespaces), !key.isEmpty else { return nil }
            return brain.project(key) ?? brain.project(named: key)
        }
        switch a.action {
        case .project:
            guard let p = project(a.target) else { return ask("No project \"\(a.target ?? "")\".") }
            brain.postProjectUpdate(p.id, content, at: c.capturedAt)
            return filed(p.id, "added to \(p.name)")
        case .newPage:
            guard let p = project(a.target) else { return ask("New page, but no project \"\(a.target ?? "")\".") }
            let title = a.title?.trimmingCharacters(in: .whitespaces).nonEmpty ?? c.title
            let id = brain.store.createPage(title: RichText(title), in: .block(p.id))
            brain.appendBody(id, markdown: content + "\n\n*Captured \(Self.day(c.capturedAt)) · \(c.source.rawValue)*")
            brain.assign(page: id, to: p.id)
            return filed(id, "new page \(title) in \(p.name)")
        case .page:
            guard let pid = a.target, let page = brain.store.blocks[pid], page.trashedAt == nil else {
                return ask("No page \(a.target ?? "").")
            }
            guard let p = brain.project(ofPage: pid) else { return ask("\(page.title) is outside your projects — only project pages are edited.") }
            brain.appendBody(pid, markdown: content)
            return filed(pid, "appended to \(page.title) (\(p.name))")
        case .task:
            guard let db = taskDatabase() else { return ask("Task \"\(a.title ?? c.title)\", but there is no task database.") }
            let title = a.title?.trimmingCharacters(in: .whitespaces).nonEmpty ?? c.title
            let row = brain.store.addRow(to: db, title: RichText(title))
            if content != title { brain.appendBody(row, markdown: content) }
            return filed(row, "task \(title)")
        case .memory:
            let title = a.title?.trimmingCharacters(in: .whitespaces).nonEmpty ?? c.title
            let id = brain.saveMemory(title: title, kind: .Notes, body: content)
            return filed(id, "memory \(title)")
        case .ask:
            return ask(note.isEmpty ? "Not sure where this belongs." : note)
        case .discard:
            brain.setCaptureStatus(c.id, .discarded, note: note.isEmpty ? "Discarded" : note)
            return CaptureOutcome(capture: c.id, result: .discarded, message: "Discarded \(c.title)")
        }
    }

    /// The user's task database: the first non-Brain database named like a task list.
    public func taskDatabase() -> RecordID? {
        brain.store.databases.values
            .filter { Self.taskDatabaseNames.contains($0.title.plainText.trimmingCharacters(in: .whitespaces).lowercased()) }
            .filter { brain.store.blocks[$0.blockID].map { $0.trashedAt == nil && $0.parent != .block(brain.rootID) } ?? false }
            .min { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }?.id
    }

    /// One pass without tools: asks `complete` (system, user) → text for a plan and applies it. Captures the plan
    /// leaves out stay pending for the next pass.
    public func run(limit: Int = 30, complete: (String, String) async throws -> String) async throws -> [CaptureOutcome] {
        let pending = brain.pendingCaptures(limit: limit)
        guard !pending.isEmpty else { return [] }
        let answer = try await complete(Self.agentInstructions, prompt(for: pending))
        let ids = Set(pending.map(\.id))
        var seen = Set<RecordID>()
        return Self.parsePlan(answer).filter { ids.contains($0.capture) && seen.insert($0.capture).inserted }.map { apply($0) }
    }

    nonisolated static func day(_ d: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.string(from: d)
    }
}

// MARK: - Tools

@MainActor
extension AgentTools {
    static let captureSpecs: [ToolSpec] = [
        ToolSpec(name: "capture", description: "Jot something down for the user: a thought, a link, a to-do. It lands in the Captures database and is sorted into the right project, page or task list by the nightly \"Sort captures\" agent. Use it when the user says \"note that\", \"remember to look at\", or shares something to keep. Example: capture {\"text\": \"Idea: export Publit chapters as EPUB\"}.",
                 inputSchema: .schema(["text": .str("What to keep, in the user's words"), "url": .str("Optional web link"),
                                       "source": .str("Optional: Mac | iPhone | Watch | Share | Mail | Agent | Shortcut (default Agent)")])),
        ToolSpec(name: "list_captures", description: "List captures waiting to be sorted (New / Transcribed), oldest first, with id, source, time and text. Use all=true to include filed and discarded ones. Sort them with file_capture.",
                 inputSchema: .schema(["all": ["type": "boolean", "description": "Also filed and discarded captures"], "limit": .num("Max captures (default 30)"), "offset": .num("Skip this many (paging)")])),
        ToolSpec(name: "file_capture", description: "File one capture. action: project (append to a project's Latest updates; target = project), new_page (new page inside a project; target = project, title), page (append to an existing project page; target = page id), task (row in the user's task database; title), memory (save as a memory; title), ask (unsure — the user decides in the Inbox; note = your suggestion), discard (note = why). Only project pages, the task database and Memories are edited; anything else turns into a question. Example: file_capture {\"capture_id\": \"…\", \"action\": \"task\", \"title\": \"Call the printer about the Publit proofs\"}.",
                 inputSchema: .schema(["capture_id": .str("Capture id (from list_captures)"),
                                       "action": .str("project | new_page | page | task | memory | ask | discard"),
                                       "target": .str("Project id/name, or page id for action page"),
                                       "title": .str("Title for new_page, task or memory"),
                                       "text": .str("Optional cleaned-up text (default: the capture as is)"),
                                       "note": .str("Short reason or suggestion")], required: ["capture_id", "action"])),
    ]

    func captureTool(_ name: String, _ a: JSONValue) throws -> String {
        switch name {
        case "capture":
            do {
                let id = try brain.addCapture(CaptureInput.from(json: a, defaultSource: .agent))
                return "Captured (id: \(id)). The \"\(BrainStore.captureSorterName)\" agent sorts it tonight."
            } catch let p as CaptureInput.Problem { throw ToolError(p.description) }
        case "list_captures":
            let all = a["all"]?.bool == true
            let items = all ? brain.captures() : brain.pendingCaptures(limit: 1000)
            let (page, more) = Self.page(items, a, defaultLimit: 30)
            if page.isEmpty {
                let waiting = brain.captures([.new]).filter(\.needsTranscript).count
                return "Nothing to sort." + (waiting > 0 ? " \(waiting) voice note(s) wait for a transcript." : "")
            }
            return page.map { c in
                var s = "- \(c.title) (id: \(c.id)) · \(c.source.rawValue) · \(CaptureSorter.day(c.capturedAt))"
                if all { s += " · \(c.status.rawValue)" + (c.note.isEmpty ? "" : ": \(c.note)") }
                let t = (c.text + (c.link.map { "\n" + $0 } ?? "")).replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
                if !t.isEmpty, t != c.title { s += "\n  " + String(t.prefix(500)) }
                return s
            }.joined(separator: "\n") + more
        case "file_capture":
            guard let action = CaptureAction.from(json: a) else {
                throw ToolError("Need capture_id and an action: " + CaptureAction.Kind.allCases.map(\.rawValue).joined(separator: " | "))
            }
            let o = CaptureSorter(brain: brain).apply(action)
            if case .skipped = o.result { throw ToolError(o.message) }
            return o.message
        default:
            throw ToolError("Unknown capture tool \(name)")
        }
    }
}
