import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-44: Projects database, migration from session project names, assignment, tools.
@MainActor
struct ProjectStoreTests {
    private func make() -> (WorkspaceStore, BrainStore) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        return (store, BrainStore(store: store))
    }

    @Test func oldSessionProjectNamesBecomeProjects() {
        let (store, brain) = make()
        // Data as written before BSD-44: sessions with a text project (or only a folder), no Projects database.
        let a = brain.createSession(title: "Fix sync", agentID: "claude", machine: "mac", cwd: "/Users/e/Code/Based", encrypted: false)
        let b = brain.createSession(title: "Tests", agentID: "codex", machine: "mac", cwd: "/tmp/x", encrypted: false, project: "Based")
        let c = brain.createSession(title: "Blog", agentID: "claude", machine: "mac", cwd: "/Users/e/blog", encrypted: false, project: "Website")
        let chat = brain.createSession(title: "Hi", agentID: "based", machine: "mac", cwd: "", encrypted: false)
        #expect(brain.projects().isEmpty, "reading never creates the database")
        #expect(brain.existingProjectsDB == nil)

        let db = brain.ensureProjects()
        let ps = brain.projects()
        #expect(ps.map(\.name).sorted() == ["Based", "Website"], "one project per distinct name, case-insensitive")
        let based = brain.project(named: "based")!
        #expect(based.folder == "/Users/e/Code/Based", "folder taken from the session whose folder has the project's name")
        #expect(brain.project(named: "Website")?.folder == "", "folder name differs → no folder guessed")
        #expect(brain.projectID(ofSession: a) == based.id && brain.projectID(ofSession: b) == based.id)
        #expect(brain.projectID(ofSession: c) == brain.project(named: "Website")?.id)
        #expect(brain.projectID(ofSession: chat) == nil)
        // Old text values stay as they were (nothing renamed or deleted).
        #expect(brain.sessions().first { $0.id == b }?.project == "Based")
        #expect(store.rows(of: brain.sessionsDB).count == 4)
        // Overview page template.
        #expect(brain.body(of: based.id).contains("## Latest updates"))
        // Running it again changes nothing.
        #expect(brain.ensureProjects() == db)
        #expect(brain.projects().count == 2)
        // Protected like the other Brain databases.
        let host = store.databases[db]!.blockID
        #expect(store.protectedIDs.contains(host))
        #expect(store.trashPages([host]).isEmpty)
    }

    @Test func newSessionsAndTheirRunsJoinTheProjectByFolder() {
        let (_, brain) = make()
        let p = brain.createProject(name: "Based", goal: "A native Notion alternative.", folder: "/Users/e/Code/Based/")
        let inner = brain.createProject(name: "Server", folder: "/Users/e/Code/Based/server")
        let s = brain.createSession(title: "Fix", agentID: "claude", machine: "mac", cwd: "/Users/e/Code/Based/App", encrypted: false)
        #expect(brain.projectID(ofSession: s) == p)
        #expect(brain.latestRun(forSession: s)?.projectID == p, "the session's run is in the same project")
        let deep = brain.createSession(title: "API", agentID: "claude", machine: "mac", cwd: "/Users/e/Code/Based/server/x", encrypted: false)
        #expect(brain.projectID(ofSession: deep) == inner, "deepest folder wins")
        let other = brain.createSession(title: "Else", agentID: "claude", machine: "mac", cwd: "/Users/e/Code/BasedOld", encrypted: false)
        #expect(brain.projectID(ofSession: other) == nil, "folder prefix must end at a path separator")
        #expect(brain.projects().count == 2, "sessions never create projects")
        // Chat turns after assignment carry the project.
        let chat = brain.createSession(title: "Q", agentID: "based", machine: "mac", cwd: "", encrypted: false)
        brain.assign(session: chat, to: p)
        #expect(brain.sessions().first { $0.id == chat }?.project == "Based")
        #expect(brain.latestRun(forSession: chat)?.projectID == p)
        brain.updateSession(chat, status: .running); brain.updateSession(chat, status: .done)
        brain.updateSession(chat, status: .running)
        #expect(brain.runs(RunFilter(sessionID: chat)).allSatisfy { $0.projectID == p })
        #expect(brain.sessions(inProject: p).count == 2)
        #expect(brain.runs(inProject: p).count == 3)
        brain.assign(session: chat, to: nil)
        #expect(brain.projectID(ofSession: chat) == nil)
    }

    @Test func pagesStatusAndUpdates() {
        let (store, brain) = make()
        let p = brain.createProject(name: "Garden")
        let q = brain.createProject(name: "House", status: .paused)
        let page = store.createPage(title: "Seeds", in: .workspace)
        let child = store.createPage(title: "Tomatoes", in: .block(page))
        brain.assign(page: page, to: p)
        #expect(brain.project(p)?.pageIDs == [page])
        #expect(brain.project(ofPage: child)?.id == p, "subpages belong to the project of their parent")
        #expect(brain.project(ofPage: p)?.id == p)
        brain.assign(page: page, to: q)
        #expect(brain.project(p)?.pageIDs == [] && brain.project(q)?.pageIDs == [page], "a page is in one project")
        brain.assign(page: page, to: nil)
        #expect(brain.project(ofPage: page) == nil)
        #expect(brain.projects().map(\.name) == ["Garden", "House"], "active before paused")

        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        brain.postProjectUpdate(p, "Sowed tomatoes.", at: t0)
        brain.postProjectUpdate(p, "Watered.", status: .done, at: t0.addingTimeInterval(3600))
        let body = brain.body(of: p)
        let first = body.range(of: "Watered.")!, second = body.range(of: "Sowed tomatoes.")!
        #expect(first.lowerBound < second.lowerBound, "newest update on top")
        #expect(body.range(of: "## Latest updates")!.lowerBound < first.lowerBound)
        #expect(brain.project(p)?.status == .done)
        // A page without the section gets one.
        brain.setBody(q, markdown: "Just notes")
        brain.postProjectUpdate(q, "Started.")
        #expect(brain.body(of: q).contains("## Latest updates") && brain.body(of: q).contains("Started."))
    }

    @Test func runsCreatedBeforeProjectsGetTheColumnLater() {
        let (store, brain) = make()
        let r = brain.startRun(title: "Old", kind: .main)
        #expect(brain.run(r)?.projectID == nil)
        let p = brain.createProject(name: "Later")
        #expect(store.databases[brain.runsDB]!.properties.contains { $0.name == "Project" && $0.relation != nil })
        brain.assign(run: r, to: p)
        #expect(brain.run(r)?.projectID == p)
    }

    @Test func projectTools() {
        let (store, brain) = make()
        let tools = AgentTools(store: store, brain: brain)
        #expect(tools.call("list_projects", [:]).text == "No projects yet.")
        let p = brain.createProject(name: "Based", goal: "Replace Notion.", folder: "/code/based")
        let s = brain.createSession(title: "Fix", agentID: "claude", machine: "m", cwd: "/code/based", encrypted: false)
        brain.updateSession(s, status: .running)
        let list = tools.call("list_projects", [:]).text
        #expect(list.contains("Based [Active]") && list.contains("Replace Notion.") && list.contains("1 chats/sessions, 1 runs"))
        let up = tools.call("update_project_status", ["project": "based", "update": "Shipped runs.", "status": "Paused"])
        #expect(!up.isError)
        #expect(brain.project(p)?.status == .paused)
        let got = tools.call("get_project", ["project": .string(p)]).text
        #expect(got.contains("Shipped runs.") && got.contains("Fix") && got.contains("Recent runs"))
        #expect(tools.call("get_project", ["project": "nope"]).isError)
        #expect(tools.call("update_project_status", ["project": "Based", "update": "x", "status": "weird"]).isError)
    }
}
