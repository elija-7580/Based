import Foundation
import Testing
import BasedCore
@testable import BasedBrain

@MainActor
struct ShareTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)")

    func server() throws -> (WorkspaceStore, SyncServer, ShareService) {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let s = WorkspaceStore(persistence: try SQLitePersistence(url: dir.appendingPathComponent("s.sqlite")), node: "s")
        return (s, SyncServer(store: s), ShareService(store: s))
    }

    @Test func sha256MatchesKnownVectors() {
        #expect(Sha256.hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(Sha256.hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(Sha256.hex(String(repeating: "a", count: 1000)) == "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
        let t = SecureToken.make(prefix: "bdl_")
        #expect(t.hasPrefix("bdl_") && t.count == 36 && !t.contains("+") && !t.contains("/"))
        #expect(SecureToken.make() != SecureToken.make())
    }

    @Test func linkSeesOnlyItsSubtreeAndCanEdit() throws {
        let (store, sync, share) = try server()
        let shared = store.createPage(title: "Projekt")
        let sub = store.createPage(title: "Notizen", in: .block(shared))
        let para = store.insertBlock(.text, text: "hallo", in: .block(sub))
        let db = store.createDatabase(title: "Tasks", in: .block(shared), inline: true, sampleRows: 1)
        let secret = store.createPage(title: "Privat")
        _ = store.insertBlock(.text, text: "geheim", in: .block(secret))

        // Only full access may share; the owner has it everywhere.
        let link = try share.createLink(.access, pageID: shared, role: .edit, by: .owner)
        #expect(throws: ShareError.self) { try share.createLink(.access, pageID: shared, role: .full, by: .owner) }
        let p = try #require(share.principal(forToken: link.secret))
        #expect(share.principal(forToken: "bdl_nope") == nil)
        #expect(share.roots(for: p).map(\.pageID) == [shared])

        let snap = share.snapshot(for: p)
        let ids = Set(snap.records.map(\.key.id))
        #expect(ids.isSuperset(of: [shared, sub, para, db.blockID, db.databaseID]))
        #expect(!ids.contains(secret))
        #expect(!snap.records.contains { if case .workspace = $0 { return true } else { return false } })
        // Database rows are inside the shared page too.
        let rows = store.rows(of: db.databaseID)
        #expect(rows.allSatisfy { ids.contains($0.id) })

        // Edit inside: accepted. Edit outside or move out: rejected and rolled back with the server copy.
        var b = try #require(store.blocks[para]); b.text = RichText("hallo welt"); b.stamp = Stamp(millis: Int64.max / 4, counter: 0, node: "web")
        var leak = try #require(store.blocks[secret]); leak.text = RichText("gehackt"); leak.stamp = b.stamp
        var move = try #require(store.blocks[sub]); move.parent = .workspace; move.stamp = b.stamp
        let r = share.push(for: p, sync: sync, SyncPush(records: [.block(b), .block(leak), .block(move)], deletions: [RecordKey(.block, secret)]))
        #expect(store.blocks[para]?.text.plainText == "hallo welt")
        #expect(store.blocks[secret]?.title == "Privat")
        #expect(store.blocks[sub]?.parent == .block(shared))
        #expect(Set(r.rejected) == [RecordKey(.block, secret), RecordKey(.block, sub)])
        #expect(r.reply.newer.contains { $0.key.id == sub }, "the client gets its move undone")
        #expect(!r.reply.newer.contains { $0.key.id == secret }, "no server copy of what it can't read")

        // A new block under a new page in the same push is fine (checked against the pushed parent).
        let newPage = Block(type: .page, parent: .block(shared), sortKey: "z", text: RichText("Neu"))
        var newPara = Block(type: .text, parent: .block(newPage.id), sortKey: "a", text: RichText("x"))
        newPara.stamp = Stamp(millis: 1, counter: 0, node: "web")
        let r2 = share.push(for: p, sync: sync, SyncPush(records: [.block(newPara), .block(newPage)], deletions: []))
        #expect(r2.rejected.isEmpty)
        #expect(store.blocks[newPara.id] != nil)
    }

    @Test func viewersCantWriteAndRevokedLinksStop() throws {
        let (store, sync, share) = try server()
        let page = store.createPage(title: "Handout")
        let para = store.insertBlock(.text, text: "a", in: .block(page))
        let link = try share.createLink(.access, pageID: page, role: .view, by: .owner)
        let p = try #require(share.principal(forToken: link.secret))
        var b = try #require(store.blocks[para]); b.text = RichText("b"); b.stamp = Stamp(millis: Int64.max / 4, counter: 0, node: "web")
        let r = share.push(for: p, sync: sync, SyncPush(records: [.block(b)], deletions: []))
        #expect(r.rejected == [RecordKey(.block, para)])
        #expect(store.blocks[para]?.text.plainText == "a")
        // Viewers can't share further.
        #expect(throws: ShareError.self) { try share.createLink(.access, pageID: page, role: .view, by: p) }

        try share.revokeLink(link.link.id, by: .owner)
        #expect(share.principal(forToken: link.secret) == nil)

        var t = Date()
        share.now = { t }
        let expiring = try share.createLink(.access, pageID: page, role: .view, by: .owner, expiresAt: t.addingTimeInterval(60))
        #expect(share.principal(forToken: expiring.secret) != nil)
        t = t.addingTimeInterval(120)
        #expect(share.principal(forToken: expiring.secret) == nil)
    }

    @Test func invitesCreateUsersWithDeviceTokensAndPersist() throws {
        let (store, sync, share) = try server()
        let team = store.createPage(title: "Team")
        let sub = store.createPage(title: "Plan", in: .block(team))
        let subText = store.insertBlock(.text, text: "Inhalt", in: .block(sub))
        let subDB = store.createDatabase(title: "Liste", in: .block(sub), inline: true, sampleRows: 0)
        let other = store.createPage(title: "Other")
        let invite = try share.createLink(.invite, pageID: team, role: .full, by: .owner, uses: 1)
        // Invite secrets don't sign anyone in by themselves.
        #expect(share.principal(forToken: invite.secret) == nil)
        let joined = try share.acceptInvite(secret: invite.secret, name: "  Anna ")
        #expect(joined.user.name == "Anna")
        #expect(throws: ShareError.self) { try share.acceptInvite(secret: invite.secret, name: "Bob") }  // single use

        let anna = try #require(share.principal(forToken: joined.token))
        #expect(share.role(of: anna, onPage: sub) == .full)
        #expect(share.role(of: anna, onPage: other) == nil)
        // Anna (full access) shares on, but not more than she has and not outside.
        _ = try share.createLink(.access, pageID: sub, role: .view, by: anna)
        #expect(throws: ShareError.self) { try share.createLink(.access, pageID: other, role: .view, by: anna) }

        // A page moved out of the shared area turns into a deletion in Anna's change feed.
        let seq = share.snapshot(for: anna).next
        store.moveBlocks([sub], to: .workspace, at: .end)
        let page = share.pullPage(for: anna, sync: sync, after: seq, limit: 100)
        #expect(page.deletions.contains(RecordKey(.block, sub)))
        #expect(!page.records.contains { $0.key.id == sub })
        // …and takes its unchanged content with it, so nothing lingers in Anna's copy.
        #expect(page.deletions.contains(RecordKey(.block, subText)))
        #expect(page.deletions.contains(RecordKey(.block, subDB.blockID)))
        #expect(page.deletions.contains(RecordKey(.database, subDB.databaseID)))
        #expect(Set(page.deletions).count == page.deletions.count)

        // Survives a restart (stored in the server's meta table).
        let again = ShareService(store: store)
        #expect(again.principal(forToken: joined.token) != nil)
        #expect(again.state.links.count == 2)

        // Publishing: read-only only.
        #expect(throws: ShareError.self) { try share.createLink(.publish, pageID: team, role: .edit, by: .owner) }
        let pub = try share.createLink(.publish, pageID: team, role: .view, by: .owner)
        #expect(share.publishedLink(id: pub.link.id)?.pageID == team)
        #expect(share.access(to: team).grants.count == 1)
    }
}
