import Foundation
import BasedCore

// BSD-44: projects are a first-class concept. Each project is a page in the "Projects" database inside the Agent
// Brain (protected like the other Brain databases) with a status, a one-sentence goal, an optional folder for coding
// agents, related pages and an optional responsible agent. Chats/sessions and runs point at their project; the
// project page body is the overview the main agent keeps up to date ("Status", "Next steps", "Latest updates").

public struct AgentProject: Sendable, Identifiable, Equatable {
    public enum Status: String, CaseIterable, Sendable { case active = "Active", paused = "Paused", done = "Done" }
    public var id: RecordID
    public var name: String
    public var status: Status
    /// One sentence: what the project is for (every task traces back to it).
    public var goal: String
    /// Working directory for coding agents (optional).
    public var folder: String
    /// Pages that belong to the project.
    public var pageIDs: [RecordID]
    /// Responsible agent (row of the Agents database).
    public var agentID: RecordID?
    public var updatedAt: Date
}

@MainActor
extension BrainStore {
    static let projectsMetaKey = "brain.projects"
    static let projectBodyTemplate = "## Status\n\n## Next steps\n\n## Latest updates\n"
    static let latestUpdatesHeading = "Latest updates"

    enum ProjectCol {
        static let status = "Status", goal = "Goal", folder = "Folder", pages = "Pages", agent = "Agent"
        /// Relation column on Sessions (their old text column "Project" keeps the display name).
        static let sessionLink = "Project page"
    }

    /// Creates the Projects database on first use (or adopts a synced one), adds missing columns, links Sessions and
    /// Runs to it and protects it. On creation it migrates the project names that sessions had as text: one project
    /// per distinct name, sessions linked to it — only adds, never deletes or renames anything.
    @discardableResult
    public func ensureProjects() -> RecordID {
        let (db, created) = ensureBrainDatabase(title: "Projects", metaKey: Self.projectsMetaKey)
        ensureColumn(db, ProjectCol.status, .select) { s in
            s.options = AgentProject.Status.allCases.map { st in
                SelectOption(name: st.rawValue, color: st == .active ? .green : st == .paused ? .yellow : .gray)
            }
        }
        ensureColumn(db, ProjectCol.goal, .text)
        ensureColumn(db, ProjectCol.folder, .text)
        ensureColumn(db, ProjectCol.pages, .text)
        ensureRelation(db, ProjectCol.agent, to: agentsDB)
        ensureRelation(sessionsDB, ProjectCol.sessionLink, to: db)
        if let runs = existingRunsDB { ensureRelation(runs, RunCol.project, to: db) }
        if created { migrateSessionProjects(db) }
        return db
    }

    /// The Projects database when it exists (never creates it — safe to call from views).
    var existingProjectsDB: RecordID? { existingBrainDatabase(title: "Projects", metaKey: Self.projectsMetaKey) }

    public var projectsDB: RecordID { ensureProjects() }

    private func migrateSessionProjects(_ db: RecordID) {
        var byName: [String: RecordID] = [:]
        for p in projects() { byName[p.name.lowercased()] = p.id }
        // Oldest first: the project gets the name's first spelling and the folder of the oldest session whose
        // directory carries the project's name.
        let pending = sessions().filter { $0.projectID == nil && !$0.project.trimmingCharacters(in: .whitespaces).isEmpty }
            .sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }
        for s in pending {
            let name = s.project.trimmingCharacters(in: .whitespaces)
            let key = name.lowercased()
            let pid = byName[key] ?? {
                let folder = pending.first { $0.project.trimmingCharacters(in: .whitespaces).lowercased() == key
                    && !$0.cwd.isEmpty && URL(fileURLWithPath: $0.cwd).lastPathComponent.lowercased() == key }?.cwd ?? ""
                let id = createProject(name: name, folder: folder)
                byName[key] = id
                return id
            }()
            setSessionProject(s.id, pid, name: nil)
        }
    }

    // MARK: Reading

    /// All projects: active first, then paused, then done; by name within a status.
    public func projects() -> [AgentProject] {
        guard let db = existingProjectsDB else { return [] }
        let order: [AgentProject.Status: Int] = [.active: 0, .paused: 1, .done: 2]
        return store.rows(of: db).map { decodeProject($0, db) }.sorted {
            (order[$0.status]!, $0.name.lowercased()) < (order[$1.status]!, $1.name.lowercased())
        }
    }

    public func project(_ id: RecordID) -> AgentProject? {
        guard let db = existingProjectsDB, let row = store.blocks[id], row.trashedAt == nil, case .database(db) = row.parent else { return nil }
        return decodeProject(row, db)
    }

    public func project(named name: String) -> AgentProject? {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return nil }
        return projects().first { $0.name.caseInsensitiveCompare(n) == .orderedSame }
    }

    /// The project whose folder contains `path` (the deepest one when folders are nested).
    public func project(forFolder path: String) -> AgentProject? {
        let p = Self.normalizedFolder(path)
        guard !p.isEmpty else { return nil }
        return projects().filter { pr in
            let f = Self.normalizedFolder(pr.folder)
            return !f.isEmpty && (p == f || p.hasPrefix(f + "/"))
        }.max { $0.folder.count < $1.folder.count }
    }

    static func normalizedFolder(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("~") { t = (ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()) + t.dropFirst() }
        while t.count > 1, t.hasSuffix("/") { t.removeLast() }
        return t
    }

    /// Project of a page: the project row itself, or the project that lists the page (or one of its ancestors).
    public func project(ofPage id: RecordID) -> AgentProject? {
        if let p = project(id) { return p }
        let chain = Set([id] + store.ancestors(of: id).map(\.id))
        return projects().first { !chain.isDisjoint(with: $0.pageIDs) }
    }

    public func projectID(ofSession sid: RecordID) -> RecordID? { relationValue(sid, sessionsDBIfPresent, ProjectCol.sessionLink) }

    public func sessions(inProject id: RecordID) -> [AgentSession] { sessions().filter { $0.projectID == id } }
    public func runs(inProject id: RecordID) -> [AgentRun] { runs().filter { $0.projectID == id } }

    private var sessionsDBIfPresent: RecordID? {
        guard let d = store.persistence?.meta(Self.happierMetaKey) else {
            return store.contentBlocks(of: rootID).lazy.compactMap { self.store.database(forBlock: $0.id) }
                .first { $0.title.plainText == "Sessions" }?.id
        }
        struct H: Codable { var sessions: RecordID }
        return (try? JSONDecoder().decode(H.self, from: d)).map(\.sessions)
    }

    func relationValue(_ row: RecordID, _ db: RecordID?, _ col: String) -> RecordID? {
        guard let db, let pid = propID(db, col), case .relation(let ids)? = store.blocks[row]?.values[pid] else { return nil }
        return ids.first
    }

    private func decodeProject(_ row: Block, _ db: RecordID) -> AgentProject {
        var status = AgentProject.Status.active
        if let pid = propID(db, ProjectCol.status), case .select(let oid)? = row.values[pid],
           let n = store.databases[db]?.property(pid)?.option(oid)?.name, let s = AgentProject.Status(rawValue: n) { status = s }
        let pages = text(row, db, ProjectCol.pages).split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\n" }).map(String.init)
        return AgentProject(id: row.id, name: row.title, status: status, goal: text(row, db, ProjectCol.goal),
                            folder: text(row, db, ProjectCol.folder), pageIDs: pages,
                            agentID: relationValue(row.id, db, ProjectCol.agent), updatedAt: row.updatedAt)
    }

    // MARK: Writing

    @discardableResult
    public func createProject(name: String, goal: String = "", folder: String = "", status: AgentProject.Status = .active,
                              agentID: RecordID? = nil) -> RecordID {
        let db = projectsDB
        var values: [String: PropertyValue] = [:]
        if let pid = propID(db, ProjectCol.status), let oid = store.addOption(db, pid, name: status.rawValue) { values[pid] = .select(oid) }
        if !goal.isEmpty, let pid = propID(db, ProjectCol.goal) { values[pid] = .text(RichText(goal)) }
        if !folder.isEmpty, let pid = propID(db, ProjectCol.folder) { values[pid] = .text(RichText(folder)) }
        if let agentID, let pid = propID(db, ProjectCol.agent) { values[pid] = .relation([agentID]) }
        let id = store.addRow(to: db, title: RichText(name), values: values)
        store.insertImported(MarkdownImporter().parse(Self.projectBodyTemplate), in: .block(id), name: "New project")
        return id
    }

    public func setProject(_ id: RecordID, status: AgentProject.Status? = nil, goal: String? = nil, folder: String? = nil) {
        guard project(id) != nil else { return }
        let db = projectsDB
        if let status, let pid = propID(db, ProjectCol.status), let oid = store.addOption(db, pid, name: status.rawValue) {
            store.setValue(id, pid, .select(oid))
        }
        if let goal, let pid = propID(db, ProjectCol.goal) { store.setValue(id, pid, goal.isEmpty ? nil : .text(RichText(goal))) }
        if let folder, let pid = propID(db, ProjectCol.folder) { store.setValue(id, pid, folder.isEmpty ? nil : .text(RichText(folder))) }
    }

    private func setSessionProject(_ sid: RecordID, _ project: RecordID?, name: String?) {
        let sdb = sessionsDB
        guard let pid = propID(sdb, ProjectCol.sessionLink) else { return }
        store.transact("Assign project", undoable: false) { tx in
            tx.update(sid) { b in
                b.values[pid] = project.map { .relation([$0]) }
                if let name, let tp = self.propID(sdb, "Project") { b.values[tp] = name.isEmpty ? nil : .text(RichText(name)) }
            }
        }
    }

    /// Puts a chat/session into a project (nil = none). The session's text "Project" follows the project's name, so
    /// older views that group by it keep working. Its latest run moves along.
    public func assign(session sid: RecordID, to project: RecordID?) {
        guard store.blocks[sid] != nil else { return }
        _ = projectsDB
        let name = project.flatMap { self.project($0)?.name } ?? ""
        setSessionProject(sid, project, name: name)
        if let r = latestRun(forSession: sid) { assign(run: r.id, to: project) }
    }

    /// Puts a run into a project (nil = none).
    public func assign(run id: RecordID, to project: RecordID?) {
        guard run(id) != nil else { return }
        let db = runsDB
        ensureRelation(db, RunCol.project, to: projectsDB)
        guard let pid = propID(db, RunCol.project) else { return }
        store.transact("Assign project", undoable: false) { tx in tx.update(id) { $0.values[pid] = project.map { .relation([$0]) } } }
    }

    /// Adds a page to a project (removing it from any other project); nil removes it from all projects.
    public func assign(page id: RecordID, to project: RecordID?) {
        let db = projectsDB
        guard let pid = propID(db, ProjectCol.pages) else { return }
        for p in projects() {
            var ids = p.pageIDs
            let had = ids.contains(id)
            if p.id == project { if !had { ids.append(id) } } else { ids.removeAll { $0 == id } }
            if ids != p.pageIDs { store.setValue(p.id, pid, ids.isEmpty ? nil : .text(RichText(ids.joined(separator: " ")))) }
        }
    }

    /// Links a new session to an existing project by folder (deepest match) or name. Never creates a project.
    func linkSessionToProject(_ sid: RecordID, folder: String, name: String?) {
        guard existingProjectsDB != nil else { return }
        let match = project(forFolder: folder) ?? name.flatMap { project(named: $0) }
        if let match { setSessionProject(sid, match.id, name: nil) }
    }

    /// Writes a dated update to the top of the project's "Latest updates" section (newest first) and optionally
    /// changes its status. The section is created when the page has none.
    public func postProjectUpdate(_ id: RecordID, _ markdown: String, status: AgentProject.Status? = nil, at date: Date = Date()) {
        guard project(id) != nil else { return }
        if let status { setProject(id, status: status) }
        let text = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm"
        let line = "- **\(f.string(from: date))** " + text.replacingOccurrences(of: "\n", with: " ")
        let heading = store.contentBlocks(of: id).first {
            [.heading1, .heading2, .heading3].contains($0.type) && $0.text.plainText.trimmingCharacters(in: .whitespaces) == Self.latestUpdatesHeading
        }
        if let heading {
            store.insertImported(MarkdownImporter().parse(line), in: .block(id), at: .after(heading.id), name: "Project update")
        } else {
            appendBody(id, markdown: "## \(Self.latestUpdatesHeading)\n\n" + line)
        }
    }
}
