import Foundation
import Testing
@testable import BasedCore
@testable import BasedBrain

/// BSD-102: two devices create Runs/Projects (and Captures) before they have synced → after a sync round both
/// use one database with everyone's rows; projects of the same name are one; nothing is deleted.
@MainActor
struct BrainDatabaseMergeTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bsd102-\(UUID().uuidString)")

    func store(_ name: String) throws -> WorkspaceStore {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("\(name).sqlite")), node: name)
    }

    func client(_ s: WorkspaceStore, server: SyncServer) -> ServerSync {
        let c = ServerSync(store: s, baseURL: URL(string: "https://example.invalid")!, token: "t")
        c.transport = { req in
            await MainActor.run {
                let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                switch req.url!.path {
                case "/sync/v2/pull":
                    let page = server.pullPage(after: Int64(q["after"] ?? "0") ?? 0, limit: Int(q["limit"] ?? "500") ?? 500)
                    return (200, try! JSONEncoder().encode(page))
                case "/sync/v2/push":
                    let p = try! JSONDecoder().decode(SyncPush.self, from: req.httpBody!)
                    return (200, try! JSONEncoder().encode(server.pushV2(p)))
                default:
                    return (404, Data())
                }
            }
        }
        return c
    }

    func activeDatabases(_ brain: BrainStore, _ title: String) -> [Database] {
        brain.brainDatabaseCandidates(title: title).filter { brain.store.blocks[$0.blockID]?.trashedAt == nil }
    }

    @Test func offlineDuplicatesMergeAfterSync() async throws {
        let server = SyncServer(store: try store("server"))
        let a = try store("a"), b = try store("b")
        let ca = client(a, server: server), cb = client(b, server: server)

        // One Agent Brain, shared: A makes it, B adopts it after the first sync.
        let brainA = BrainStore(store: a)
        await ca.syncNow()
        await cb.syncNow()
        let brainB = BrainStore(store: b)
        #expect(brainB.rootID == brainA.rootID)
        let watchA = brainA.mergeDuplicatesAfterRemoteChanges(), watchB = brainB.mergeDuplicatesAfterRemoteChanges()
        defer { watchA.cancel(); watchB.cancel() }

        // Offline on both: each makes its own Runs and Projects database.
        let projA = brainA.createProject(name: "Publit", goal: "Ship the EPUB export")
        let runA = brainA.startRun(title: "Run on A", kind: .chat, status: .done, projectID: projA)
        try await Task.sleep(nanoseconds: 5_000_000)
        let projB = brainB.createProject(name: "publit ", folder: "/Users/e/publit")
        let runB = brainB.startRun(title: "Run on B", kind: .chat, status: .done, projectID: projB)
        brainB.postProjectUpdate(projB, "Found a bug in chapter splitting")
        #expect(brainA.runsDB != brainB.runsDB)

        await ca.syncNow(); await cb.syncNow(); await ca.syncNow()
        // Both now see two "Runs" databases; the remote-change hook merges them (coalesced, next main-actor turn).
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(activeDatabases(brainA, "Runs").count == 1, "merged by the remote-change hook")
        #expect(brainB.mergeDuplicateBrainDatabases().isEmpty, "B merged already too")
        await ca.syncNow(); await cb.syncNow(); await ca.syncNow()

        for brain in [brainA, brainB] {
            #expect(activeDatabases(brain, "Runs").count == 1)
            #expect(activeDatabases(brain, "Projects").count == 1)
            #expect(Set(brain.runs().map(\.id)) == [runA, runB], "every run on both devices")
            let projects = brain.projects()
            #expect(projects.count == 1, "one Publit")
            let p = try #require(projects.first)
            #expect(p.id == projA, "the oldest project stays")
            #expect(p.goal == "Ship the EPUB export" && p.folder == "/Users/e/publit", "fields merged")
            #expect(brain.runs(inProject: projA).count == 2, "B's run points at the kept project")
            let body = MarkdownExporter(store: brain.store).exportBlocks(brain.store.contentBlocks(of: projA), indent: 0)
            #expect(body.contains("Found a bug in chapter splitting"), "B's project notes moved over")
        }
        #expect(brainA.runsDB == brainB.runsDB)
        #expect(brainA.projectsDB == brainB.projectsDB)
        // Nothing deleted: the duplicate database and project row are in the Trash.
        let dupRuns = brainA.brainDatabaseCandidates(title: "Runs").filter { $0.id != brainA.runsDB }
        #expect(dupRuns.count == 1)
        #expect(a.blocks[dupRuns[0].blockID]?.trashedAt != nil)
        #expect(a.blocks[projB]?.trashedAt != nil)
        // The Runs → Project relation targets the kept Projects database everywhere.
        for (db, _) in brainA.relationColumns(targeting: dupRuns[0].id) { #expect(a.blocks[a.databases[db]!.blockID]?.trashedAt != nil) }
        let dupProjects = brainA.brainDatabaseCandidates(title: "Projects").filter { $0.id != brainA.projectsDB }
        #expect(dupProjects.allSatisfy { brainA.relationColumns(targeting: $0.id).isEmpty })
    }

    @Test func columnsAndSelectOptionsFollowByName() throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: s)
        let keep = brain.ensureCaptures()
        // A second "Captures" made later (as if synced from another device) with an extra column and its own options.
        let dup = s.createDatabase(title: RichText("Captures"), in: .block(brain.rootID), inline: true, sampleRows: 0).databaseID
        let status = try #require(s.addProperty(to: dup, name: "Status", type: .select))
        let filed = try #require(s.addOption(dup, status, name: "Filed"))
        let extra = try #require(s.addProperty(to: dup, name: "Mood", type: .text))
        let row = s.addRow(to: dup, title: RichText("Idea from the phone"), values: [status: .select(filed), extra: .text(RichText("happy"))])

        let report = brain.mergeDuplicateBrainDatabases()
        #expect(report.databases["Captures"] == 1 && report.rowsMoved == 1)
        #expect(brain.existingCapturesDB == keep)
        let moved = try #require(s.blocks[row])
        #expect(moved.parent == .database(keep))
        let kept = try #require(s.databases[keep])
        let keptStatus = try #require(kept.properties.first { $0.name == "Status" })
        guard case .select(let oid)? = moved.values[keptStatus.id] else { Issue.record("status lost"); return }
        #expect(keptStatus.option(oid)?.name == "Filed")
        let mood = try #require(kept.properties.first { $0.name == "Mood" })
        #expect(moved.values[mood.id] == .text(RichText("happy")), "extra column added, value kept")
        #expect(s.databases[dup] != nil && s.isTrashed(s.databases[dup]!.blockID), "duplicate trashed, not deleted")
        #expect(brain.mergeDuplicateBrainDatabases().isEmpty, "idempotent")
    }

    @Test func newerDatabaseNeverWinsThroughTheLocalMeta() throws {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let brain = BrainStore(store: s)
        let older = s.createDatabase(title: RichText("Runs"), in: .block(brain.rootID), inline: true, sampleRows: 0).databaseID
        Thread.sleep(forTimeInterval: 0.005)
        let newer = s.createDatabase(title: RichText("Runs"), in: .block(brain.rootID), inline: true, sampleRows: 0).databaseID
        struct OneID: Codable { var id: RecordID }
        s.persistence?.setMeta(BrainStore.runsMetaKey, try JSONEncoder().encode(OneID(id: newer)))
        #expect(brain.existingRunsDB == older)
        #expect(brain.ensureRuns() == older)
    }

}
