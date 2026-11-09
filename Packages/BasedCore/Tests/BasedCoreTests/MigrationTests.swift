import Foundation
import Testing
@testable import BasedCore

/// BSD-23: `PRAGMA user_version` + numbered migrations for based.sqlite.
@MainActor
@Suite struct MigrationTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("migration-\(UUID().uuidString)")

    func path(_ name: String) -> URL {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(name)
    }

    static func sqlString(_ d: Data) -> String {
        "'" + String(decoding: d, as: UTF8.self).replacingOccurrences(of: "'", with: "''") + "'"
    }

    /// A file as written before the migration list and before sync v2: records + meta, no `changes`,
    /// `user_version` 0.
    func makeV0File(_ url: URL, records: [Record]) throws {
        var sql = """
        CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(kind, id));
        CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB);
        INSERT INTO meta(key, value) VALUES('node', CAST('nodeA' AS BLOB));
        """
        for r in records {
            sql += "INSERT INTO records(kind, id, data) VALUES('\(r.key.kind.rawValue)', '\(r.key.id)', CAST(\(Self.sqlString(try r.encoded())) AS BLOB));\n"
        }
        try SQLitePersistence.rawExec(path: url.path, sql)
    }

    func samplePage(_ id: String, _ title: String) -> Block {
        var b = Block(id: id, type: .page, parent: .workspace, sortKey: "a0", text: RichText(title))
        b.stamp = Stamp(millis: 1_000, counter: 0, node: "nodeA")
        return b
    }

    @Test func v0FileOpensMigratesKeepsContentAndBacksUp() throws {
        let url = path("based.sqlite")
        var w = Workspace(name: "Old workspace")
        w.stamp = Stamp(millis: 900, counter: 0, node: "nodeA")
        let page = samplePage("p1", "Kept page")
        try makeV0File(url, records: [.workspace(w), .block(page)])

        let p = try SQLitePersistence(url: url)
        #expect(p.schemaVersion == SQLitePersistence.currentSchemaVersion)
        #expect(p.tableExists("changes"))
        #expect(p.tableExists("quarantine"))
        // Existing records become local changes (first v2 push uploads them).
        let log = try p.changes(after: 0, limit: 100)
        #expect(Set(log.map(\.key)) == [RecordKey(.workspace, w.id), RecordKey(.block, "p1")])
        #expect(log.allSatisfy { $0.local && !$0.deleted })

        let store = WorkspaceStore(persistence: p)
        #expect(store.workspace.name == "Old workspace")
        #expect(store.blocks["p1"]?.title == "Kept page")
        #expect(String(data: p.meta("node") ?? Data(), encoding: .utf8) == "nodeA")

        // A consistent backup of the old file sits next to it, and it is still version 0.
        let backup = dir.appendingPathComponent("based.sqlite.bak-v0")
        #expect(FileManager.default.fileExists(atPath: backup.path))
        #expect(String(data: p.meta("migration.backup") ?? Data(), encoding: .utf8) == backup.path)
        let old = try SQLitePersistence.openWithoutMigrating(backup)
        #expect(old.version == 0)
        #expect(old.recordCount == 2)
    }

    @Test func currentFileIsNotMigratedAgainAndNoBackup() throws {
        let url = path("based.sqlite")
        do {
            let s = WorkspaceStore(persistence: try SQLitePersistence(url: url), node: "a")
            _ = s.createPage(title: "Fresh")
        }
        // A brand-new file needs no backup.
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("based.sqlite.bak-v0").path))
        let p = try SQLitePersistence(url: url)
        #expect(p.schemaVersion == SQLitePersistence.currentSchemaVersion)
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(!names.contains { $0.contains(".bak-v") })
    }

    @Test func v1FileGetsV2AndOnlyNewestBackupIsKept() throws {
        let url = path("based.sqlite")
        try makeV0File(url, records: [.block(samplePage("p1", "A"))])
        // Simulate an older left-over backup and a v1 file (changes table present, user_version 1).
        try Data("stale".utf8).write(to: dir.appendingPathComponent("based.sqlite.bak-v0"))
        try SQLitePersistence.rawExec(path: url.path, """
        CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                              deleted INTEGER NOT NULL DEFAULT 0, local INTEGER NOT NULL DEFAULT 0);
        CREATE UNIQUE INDEX changes_key ON changes(kind, id);
        INSERT INTO changes(kind, id, deleted, local) VALUES('block', 'p1', 0, 0);
        PRAGMA user_version = 1;
        """)
        let p = try SQLitePersistence(url: url)
        #expect(p.schemaVersion == SQLitePersistence.currentSchemaVersion)
        // The v1 change log was left as it was (already-synced entry stays remote).
        let log = try p.changes(after: 0, limit: 10)
        #expect(log.count == 1 && log[0].local == false)
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.contains(".bak-v") }
        #expect(names == ["based.sqlite.bak-v1"])
    }

    @Test func newerFileIsRefusedAndUntouched() throws {
        let url = path("based.sqlite")
        try makeV0File(url, records: [.block(samplePage("p1", "From the future"))])
        try SQLitePersistence.rawExec(path: url.path, "PRAGMA user_version = 99;")
        let before = try Data(contentsOf: url)
        #expect(throws: PersistenceError.self) { _ = try SQLitePersistence(url: url) }
        do { _ = try SQLitePersistence(url: url); Issue.record("expected newerFormat") }
        catch PersistenceError.newerFormat(let found, let supported) {
            #expect(found == 99)
            #expect(supported == SQLitePersistence.currentSchemaVersion)
        }
        #expect(try Data(contentsOf: url) == before)
        switch WorkspaceOpener.open(directory: dir) {
        case .failure(.newerFormat(_, let found, _)): #expect(found == 99)
        default: Issue.record("opener should report newerFormat")
        }
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("based.sqlite.bak-v99").path))
    }

    @Test func duplicateWorkspaceRowsKeepNewestAndQuarantineTheRest() throws {
        let url = path("based.sqlite")
        var main = Workspace(name: "Main")
        main.stamp = Stamp(millis: 2_000, counter: 0, node: "a")
        var other = Workspace(id: "legacy-ws", name: "Legacy")
        other.stamp = Stamp(millis: 1_000, counter: 0, node: "b")
        try makeV0File(url, records: [.workspace(other), .workspace(main), .block(samplePage("p1", "A"))])

        let p = try SQLitePersistence(url: url)
        #expect(p.rawRow(RecordKey(.workspace, Workspace.mainID)) != nil)
        #expect(p.rawRow(RecordKey(.workspace, "legacy-ws")) == nil)
        let q = p.quarantinedKeys()
        #expect(q.map(\.key) == [RecordKey(.workspace, "legacy-ws")])
        #expect(q[0].reason.contains("duplicate"))
        // The quarantined row isn't in the change log (never synced).
        #expect(!(try p.changes(after: 0, limit: 100)).contains { $0.key.id == "legacy-ws" })
        #expect(WorkspaceStore(persistence: p).workspace.name == "Main")
    }

    @Test func bulkLoadPrefersNewestWorkspaceRegardlessOfOrder() {
        var a = Workspace(name: "Old"); a.stamp = Stamp(millis: 1, counter: 0, node: "a")
        var b = Workspace(id: "other", name: "New"); b.stamp = Stamp(millis: 5, counter: 0, node: "a")
        for order in [[a, b], [b, a]] {
            let s = WorkspaceStore(persistence: MemoryPersistence(order.map(Record.workspace)), node: "n")
            #expect(s.workspace.name == "New")
        }
    }

    @Test func undecodableWorkspaceIsPreservedBeforeReplacement() throws {
        let url = path("based.sqlite")
        let garbage = Data("{\"id\":\"workspace\",\"name\":42}".utf8)
        do {
            let p = try SQLitePersistence(url: url)
            _ = WorkspaceStore(persistence: p, node: "a")
            try p.writeRawRow(kind: .workspace, id: Workspace.mainID, data: garbage)
        }
        let p = try SQLitePersistence(url: url)
        let s = WorkspaceStore(persistence: p, node: "a")
        #expect(s.workspace.id == Workspace.mainID)
        #expect(p.quarantinedKeys().map(\.key) == [RecordKey(.workspace, Workspace.mainID)])
        #expect(!s.frozenKeys.contains(RecordKey(.workspace, Workspace.mainID)))
        // The fresh workspace is decodable again.
        #expect((try p.loadAllReporting()).undecodable.isEmpty)
    }

    @Test func foreignWorkspaceFromSyncIsIgnored() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "a")
        var foreign = Workspace(id: "someone-else", name: "Foreign")
        foreign.stamp = Stamp(millis: Int64.max / 2, counter: 0, node: "z")
        s.applyRemote([.workspace(foreign)])
        #expect(s.workspace.id == Workspace.mainID)
        #expect(s.workspace.name != "Foreign")
    }

    @Test func archiveIntoNonEmptyStoreMergesWorkspace() throws {
        let src = WorkspaceStore(persistence: MemoryPersistence(), node: "src")
        let fav = src.createPage(title: "Fav")
        src.transact("ws") { $0.updateWorkspace { $0.name = "Archive name"; $0.favorites = [fav] } }
        let archive = try WorkspaceArchive.write(src)

        let dst = WorkspaceStore(persistence: MemoryPersistence(), node: "dst")
        _ = dst.createPage(title: "Local")
        dst.transact("ws") { $0.updateWorkspace { $0.name = "Local name" } }
        try WorkspaceArchive.importArchive(archive, into: dst)
        #expect(dst.workspace.id == Workspace.mainID)
        #expect(dst.workspace.name == "Local name")
        #expect(dst.workspace.favorites.contains(fav))
        #expect(dst.allRecords().filter { $0.key.kind == .workspace }.count == 1)
    }
}

extension SQLitePersistence {
    /// Test helper: reads `user_version` and the record count of a file without running migrations.
    static func openWithoutMigrating(_ url: URL) throws -> (version: Int, recordCount: Int) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID().uuidString).sqlite")
        try FileManager.default.copyItem(at: url, to: tmp)
        defer {
            try? FileManager.default.removeItem(at: tmp)
            try? FileManager.default.removeItem(atPath: tmp.path + ".bak-v0")
        }
        // Copy the version into a table we can read through the normal API after opening (which migrates).
        try rawExec(path: tmp.path, """
        CREATE TABLE probe AS SELECT (SELECT user_version FROM pragma_user_version) AS v, (SELECT COUNT(*) FROM records) AS n;
        """)
        let p = try SQLitePersistence(url: tmp)
        return (p.scalarInt("SELECT v FROM probe") ?? -1, p.scalarInt("SELECT n FROM probe") ?? -1)
    }
}
