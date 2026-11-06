import Foundation
import BasedCore

/// A durable memory (one page per topic, like Notion AI memories).
public struct Memory: Sendable, Identifiable, Equatable {
    public enum Kind: String, CaseIterable, Sendable { case Profile, Preference, Work, People, Notes }
    public var id: RecordID
    public var title: String
    public var kind: Kind
    public var body: String
    public var updatedAt: Date
}

/// Reusable instructions (a skill page): name, description, Markdown body.
public struct Skill: Sendable, Identifiable, Equatable {
    public var id: RecordID
    public var name: String
    public var description: String
    public var enabled: Bool
    public var body: String
}

/// A custom agent: instructions page + optional schedule and model.
public struct Agent: Sendable, Identifiable, Equatable {
    public var id: RecordID
    public var name: String
    public var instructions: String
    public var schedule: String?        // see Schedule.parse
    public var model: String?           // "anthropic/claude-sonnet-4-5" or bare model
    public var enabled: Bool
    public var lastRun: Date?
    public var dailyTokenBudget: Int?   // nil = unlimited
}

/// The "Agent Brain" lives inside the workspace as a page with three databases, so it syncs like
/// everything else and every connected client (app, MCP, scheduler) sees the same memories and skills.
@MainActor
public final class BrainStore {
    public let store: WorkspaceStore
    public private(set) var rootID: RecordID = ""
    public private(set) var memoriesDB: RecordID = ""
    public private(set) var skillsDB: RecordID = ""
    public private(set) var agentsDB: RecordID = ""
    public private(set) var aboutID: RecordID = ""

    static let metaKey = "brain.ids"

    public init(store: WorkspaceStore) {
        self.store = store
        if !load() { bootstrap() }
        repair()
    }

    /// Ids of the records that make up the brain (page, About, database hosts and databases).
    public var coreIDs: Set<RecordID> {
        var out: Set<RecordID> = [rootID, aboutID]
        for db in [memoriesDB, skillsDB, agentsDB] where !db.isEmpty {
            if let host = store.databases[db]?.blockID { out.insert(host) }
        }
        out.remove("")
        return out
    }

    /// Keeps the Agent Brain intact: its pages can't be trashed or deleted (store-level protection), and
    /// anything that got trashed anyway (older builds, another device, sync) is restored; a database that
    /// is gone is recreated. Returns true when something had to be fixed.
    @discardableResult
    public func repair() -> Bool {
        var fixed = false
        if store.blocks[rootID] == nil {
            if !load() { bootstrap() }
            fixed = true
        }
        if store.blocks[aboutID] == nil {
            aboutID = store.createPage(title: "About me", in: .block(rootID), icon: .emoji("👤"))
            fixed = true
        }
        if store.databases[memoriesDB] == nil { memoriesDB = makeMemoriesDB(); fixed = true }
        if store.databases[skillsDB] == nil { skillsDB = makeSkillsDB(); fixed = true }
        if store.databases[agentsDB] == nil { agentsDB = makeAgentsDB(); fixed = true }
        if fixed { save() }
        let ids = coreIDs
        store.protectedIDs.formUnion(ids)
        // Restore trashed parts (the root first so its children come back in place).
        if store.blocks[rootID]?.trashedAt != nil { store.restorePages([rootID]); fixed = true }
        let trashed = ids.filter { $0 != rootID && store.blocks[$0]?.trashedAt != nil }.sorted()
        if !trashed.isEmpty { store.restorePages(trashed); fixed = true }
        // Still hidden because a page it was moved into is in the Trash → back to the top level.
        if store.isTrashed(rootID) { store.movePages([rootID], to: .privateTop); fixed = true }
        return fixed
    }

    private struct IDs: Codable { var root, memories, skills, agents, about: RecordID }

    private func load() -> Bool {
        guard let data = store.persistence?.meta(Self.metaKey), let ids = try? JSONDecoder().decode(IDs.self, from: data),
              store.blocks[ids.root] != nil, store.databases[ids.memories] != nil else {
            // Fall back to finding an existing brain page by title (e.g. after a fresh sync).
            if let root = store.topLevelPages().first(where: { $0.title == "Agent Brain" }), adopt(root.id) { return true }
            return false
        }
        rootID = ids.root; memoriesDB = ids.memories; skillsDB = ids.skills; agentsDB = ids.agents; aboutID = ids.about
        return true
    }

    private func adopt(_ root: RecordID) -> Bool {
        var mem: RecordID?, sk: RecordID?, ag: RecordID?, about: RecordID?
        for b in store.contentBlocks(of: root) {
            if let db = store.database(forBlock: b.id) {
                switch db.title.plainText { case "Memories": mem = db.id; case "Skills": sk = db.id; case "Agents": ag = db.id; default: break }
            } else if b.type == .page, b.title == "About me" { about = b.id }
        }
        guard let mem, let sk, let ag else { return false }
        rootID = root; memoriesDB = mem; skillsDB = sk; agentsDB = ag; aboutID = about ?? store.createPage(title: "About me", in: .block(root), icon: .emoji("👤"))
        save(); return true
    }

    private func save() {
        let ids = IDs(root: rootID, memories: memoriesDB, skills: skillsDB, agents: agentsDB, about: aboutID)
        store.persistence?.setMeta(Self.metaKey, try? JSONEncoder().encode(ids))
    }

    private func bootstrap() {
        rootID = store.createPage(title: "Agent Brain", in: .workspace, icon: .emoji("🧠"), name: "Create Agent Brain")
        aboutID = store.createPage(title: "About me", in: .block(rootID), icon: .emoji("👤"))
        store.insertImported(MarkdownImporter().parse("## Role\n\n## Current work\n\n## Working preferences\n"), in: .block(aboutID))

        memoriesDB = makeMemoriesDB()
        skillsDB = makeSkillsDB()
        agentsDB = makeAgentsDB()
        save()
    }

    private func makeMemoriesDB() -> RecordID {
        let db = store.createDatabase(title: "Memories", in: .block(rootID), inline: true, sampleRows: 0).databaseID
        if let pid = store.addProperty(to: db, name: "Type", type: .select) {
            for k in Memory.Kind.allCases { _ = store.addOption(db, pid, name: k.rawValue) }
        }
        return db
    }

    private func makeSkillsDB() -> RecordID {
        let db = store.createDatabase(title: "Skills", in: .block(rootID), inline: true, sampleRows: 0).databaseID
        _ = store.addProperty(to: db, name: "Description", type: .text)
        _ = store.addProperty(to: db, name: "Enabled", type: .checkbox)
        return db
    }

    private func makeAgentsDB() -> RecordID {
        let db = store.createDatabase(title: "Agents", in: .block(rootID), inline: true, sampleRows: 0).databaseID
        _ = store.addProperty(to: db, name: "Schedule", type: .text)
        _ = store.addProperty(to: db, name: "Model", type: .text)
        _ = store.addProperty(to: db, name: "Enabled", type: .checkbox)
        _ = store.addProperty(to: db, name: "Last run", type: .date)
        _ = store.addProperty(to: db, name: "Daily token budget", type: .number)
        return db
    }

    // MARK: Helpers

    func propID(_ db: RecordID, _ name: String) -> String? { store.databases[db]?.properties.first { $0.name == name }?.id }
    func text(_ row: Block, _ db: RecordID, _ name: String) -> String {
        guard let pid = propID(db, name), case .text(let t)? = row.values[pid] else { return "" }
        return t.plainText
    }
    func bool(_ row: Block, _ db: RecordID, _ name: String, default d: Bool) -> Bool {
        guard let pid = propID(db, name), case .checkbox(let b)? = row.values[pid] else { return d }
        return b
    }
    public func body(of id: RecordID) -> String { MarkdownExporter(store: store).export(page: id, includeTitle: false) }

    public func setBody(_ id: RecordID, markdown: String) {
        let old = store.contentBlocks(of: id).map(\.id)
        if !old.isEmpty { store.deleteBlocks(old) }
        store.insertImported(MarkdownImporter().parse(markdown), in: .block(id), name: "Update page")
    }

    public func appendBody(_ id: RecordID, markdown: String) {
        store.insertImported(MarkdownImporter().parse(markdown), in: .block(id), name: "Append")
    }

    // MARK: Memories

    public var about: String { body(of: aboutID) }
    public func setAbout(_ md: String) { setBody(aboutID, markdown: md) }

    public func memories() -> [Memory] {
        let typeID = propID(memoriesDB, "Type")
        let schema = store.databases[memoriesDB]?.properties.first { $0.id == typeID }
        return store.rows(of: memoriesDB).map { row in
            var kind = Memory.Kind.Notes
            if let typeID, case .select(let oid)? = row.values[typeID], let n = schema?.option(oid)?.name, let k = Memory.Kind(rawValue: n) { kind = k }
            return Memory(id: row.id, title: row.title, kind: kind, body: body(of: row.id), updatedAt: row.updatedAt)
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    public func searchMemories(_ query: String, limit: Int = 8) -> [Memory] {
        let q = query.lowercased().split(separator: " ").map(String.init).filter { $0.count > 2 }
        let all = memories()
        if q.isEmpty { return Array(all.prefix(limit)) }
        func score(_ m: Memory) -> Int {
            let hay = (m.title + " " + m.body).lowercased()
            return q.reduce(0) { $0 + (m.title.lowercased().contains($1) ? 3 : 0) + (hay.contains($1) ? 1 : 0) }
        }
        return all.map { ($0, score($0)) }.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }.prefix(limit).map(\.0)
    }

    @discardableResult
    public func saveMemory(title: String, kind: Memory.Kind, body: String) -> RecordID {
        if let existing = memories().first(where: { $0.title.caseInsensitiveCompare(title) == .orderedSame }) {
            appendBody(existing.id, markdown: body)
            return existing.id
        }
        var values: [String: PropertyValue] = [:]
        if let pid = propID(memoriesDB, "Type"), let oid = store.addOption(memoriesDB, pid, name: kind.rawValue) { values[pid] = .select(oid) }
        let id = store.addRow(to: memoriesDB, title: RichText(title), values: values)
        setBody(id, markdown: body)
        return id
    }

    public func deleteMemory(_ id: RecordID) { store.trash([id]) }

    // MARK: Skills

    public func skills(enabledOnly: Bool = false) -> [Skill] {
        store.rows(of: skillsDB).map { row in
            Skill(id: row.id, name: row.title, description: text(row, skillsDB, "Description"),
                  enabled: bool(row, skillsDB, "Enabled", default: true), body: body(of: row.id))
        }.filter { !enabledOnly || $0.enabled }.sorted { $0.name < $1.name }
    }

    @discardableResult
    public func saveSkill(name: String, description: String, body: String) -> RecordID {
        var values: [String: PropertyValue] = [:]
        if let p = propID(skillsDB, "Description") { values[p] = .text(RichText(description)) }
        if let p = propID(skillsDB, "Enabled") { values[p] = .checkbox(true) }
        let id = skills().first { $0.name == name }?.id ?? store.addRow(to: skillsDB, title: RichText(name), values: values)
        for (k, v) in values { store.setValue(id, k, v) }
        setBody(id, markdown: body)
        return id
    }

    // MARK: Agents

    public func agents() -> [Agent] {
        store.rows(of: agentsDB).map { row in
            var last: Date?
            if let p = propID(agentsDB, "Last run"), case .date(let d)? = row.values[p] { last = d.start }
            var budget: Int?
            if let p = propID(agentsDB, "Daily token budget"), case .number(let n)? = row.values[p] { budget = Int(n) }
            let sched = text(row, agentsDB, "Schedule"), model = text(row, agentsDB, "Model")
            return Agent(id: row.id, name: row.title, instructions: body(of: row.id),
                         schedule: sched.isEmpty ? nil : sched, model: model.isEmpty ? nil : model,
                         enabled: bool(row, agentsDB, "Enabled", default: true), lastRun: last, dailyTokenBudget: budget)
        }
    }

    @discardableResult
    public func saveAgent(name: String, instructions: String, schedule: String?, model: String?) -> RecordID {
        let id = agents().first { $0.name == name }?.id ?? store.addRow(to: agentsDB, title: RichText(name))
        if let p = propID(agentsDB, "Schedule") { store.setValue(id, p, schedule.map { .text(RichText($0)) }) }
        if let p = propID(agentsDB, "Model") { store.setValue(id, p, model.map { .text(RichText($0)) }) }
        if let p = propID(agentsDB, "Enabled") { store.setValue(id, p, .checkbox(true)) }
        setBody(id, markdown: instructions)
        return id
    }

    public func markRun(_ id: RecordID, at date: Date = Date()) {
        if let p = propID(agentsDB, "Last run") { store.setValue(id, p, .date(DateValue(start: date, includeTime: true))) }
    }

    /// Append a run log to the agent page (collapsed toggle per run).
    public func logRun(_ id: RecordID, summary: String, usage: Usage, error: String? = nil) {
        let f = ISO8601DateFormatter()
        let head = "Run \(f.string(from: Date())) · \(usage.total) tokens" + (error == nil ? "" : " · error")
        let body = (error.map { "**Error:** \($0)\n\n" } ?? "") + summary
        store.insertImported([ImportedBlock(.toggle, text: RichText(head), children: MarkdownImporter().parse(body))], in: .block(id), name: "Log run")
    }

    /// System prompt shared by every client: who the user is, memories, skill index.
    /// Short context for small models: the About page and the best-matching memories, capped at `limit` chars.
    public func compactContext(query: String?, limit: Int) -> String {
        var s = ""
        let a = about.trimmingCharacters(in: .whitespacesAndNewlines)
        if !a.isEmpty { s += "# About the user\n" + String(a.prefix(limit / 2)) + "\n" }
        let mems = query.map { searchMemories($0, limit: 5) } ?? Array(memories().prefix(5))
        if !mems.isEmpty {
            s += "# Notes about the user\n"
            for m in mems {
                let line = "- " + m.title + (m.body.isEmpty ? "" : ": " + m.body.replacingOccurrences(of: "\n", with: " ")) + "\n"
                if s.count + line.count > limit { break }
                s += line
            }
        }
        return s
    }

    public func systemContext(query: String? = nil) -> String {
        var s = "# About the user\n\(about)\n\n# Memories\n"
        let mems = query.map { searchMemories($0, limit: 12) } ?? Array(memories().prefix(12))
        for m in mems { s += "## \(m.title) (\(m.kind.rawValue))\n\(m.body)\n" }
        s += "\n# Skills (load with load_skill before following one)\n"
        for sk in skills(enabledOnly: true) { s += "- \(sk.name): \(sk.description)\n" }
        return s
    }
}
