import Foundation
import BasedCore

// Sharing on based-server: people and links get a role on a page, and the role covers everything inside it
// (sub-pages, databases, rows), like Notion. The highest role wins.
//
//   owner           BASED_TOKEN holder: everything, can share anything
//   user            someone who accepted an invite; signs in with a personal device token
//   link            whoever holds an "anyone with the link" URL (anonymous)
//
// Secrets (link secrets, device tokens) are stored only as SHA-256 hashes. Grants and links live in the server's
// SQLite meta table, next to the workspace — not in the workspace records, so they never sync to devices.
// Permission model: ReBAC tuples (subject, role, page) with inheritance down the page tree, the same shape
// OpenFGA / Zanzibar use, evaluated in-process (personal / small-team scale).

public enum ShareRole: String, Codable, Sendable, CaseIterable, Comparable {
    case view, comment, edit, full

    var rank: Int { switch self { case .view: 0; case .comment: 1; case .edit: 2; case .full: 3 } }
    public static func < (a: ShareRole, b: ShareRole) -> Bool { a.rank < b.rank }

    public var canEdit: Bool { self >= .edit }
    public var canShare: Bool { self == .full }

    public var label: String {
        switch self { case .view: "Can view"; case .comment: "Can comment"; case .edit: "Can edit"; case .full: "Full access" }
    }
}

public struct ShareUser: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var createdAt: Date
    /// SHA-256 of each device token issued to this person.
    public var tokenHashes: [String]
    public var lastSeen: Date?
}

public struct ShareGrant: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var pageID: RecordID
    public var userID: String
    public var role: ShareRole
    public var createdAt: Date
}

public struct SharingLink: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        /// Anyone with the URL gets `role` (no account).
        case access
        /// Opening it lets someone join with their name: they become a user with `role` and get a device token.
        case invite
        /// Read-only public web page at /p/<id> (server-rendered, no app needed).
        case publish
    }
    public var id: String
    public var kind: Kind
    public var pageID: RecordID
    public var role: ShareRole
    public var secretHash: String
    public var label: String?
    public var createdAt: Date
    public var expiresAt: Date?
    public var revokedAt: Date?
    /// Invites: how many more people may join with it (nil = unlimited).
    public var usesLeft: Int?
    public var lastUsed: Date?

    public func isActive(at now: Date = Date()) -> Bool {
        revokedAt == nil && (expiresAt.map { $0 > now } ?? true) && (usesLeft.map { $0 > 0 } ?? true)
    }
}

public struct ShareState: Codable, Sendable, Equatable {
    public var users: [ShareUser] = []
    public var grants: [ShareGrant] = []
    public var links: [SharingLink] = []
    public init() {}
}

public enum SharePrincipal: Equatable, Sendable {
    case owner
    case user(ShareUser)
    case link(SharingLink)

    public var label: String {
        switch self { case .owner: "Owner"; case .user(let u): u.name; case .link(let l): l.label ?? "Link" }
    }
}

public enum ShareError: Error, Equatable, CustomStringConvertible {
    case notFound, forbidden(String), invalid(String)
    public var description: String {
        switch self {
        case .notFound: "Not found."
        case .forbidden(let s): s
        case .invalid(let s): s
        }
    }
}

@MainActor
public final class ShareService {
    public let store: WorkspaceStore
    public private(set) var state: ShareState
    static let metaKey = "share.v1"
    public var now: () -> Date = Date.init

    public init(store: WorkspaceStore) {
        self.store = store
        if let d = store.persistence?.meta(Self.metaKey), let s = try? JSONDecoder().decode(ShareState.self, from: d) {
            state = s
        } else {
            state = ShareState()
        }
    }

    private func save() {
        store.persistence?.setMeta(Self.metaKey, try? JSONEncoder().encode(state))
    }

    // MARK: Principals

    /// A device token (`bdu_…`) or a link secret (`bdl_…`). The owner token is checked by the caller.
    public func principal(forToken token: String) -> SharePrincipal? {
        guard !token.isEmpty else { return nil }
        let h = Sha256.hex(token)
        if token.hasPrefix("bdu_") {
            guard let i = state.users.firstIndex(where: { $0.tokenHashes.contains { SecureToken.equal($0, h) } }) else { return nil }
            state.users[i].lastSeen = now()
            return .user(state.users[i])
        }
        if token.hasPrefix("bdl_") {
            guard let l = state.links.first(where: { SecureToken.equal($0.secretHash, h) }), l.kind == .access, l.isActive(at: now()) else { return nil }
            return .link(l)
        }
        return nil
    }

    public func link(secret: String) -> SharingLink? {
        let h = Sha256.hex(secret)
        return state.links.first { SecureToken.equal($0.secretHash, h) }
    }

    public func publishedLink(id: String) -> SharingLink? {
        state.links.first { $0.id == id && $0.kind == .publish && $0.isActive(at: now()) }
    }

    // MARK: Roles

    /// The pages a principal has a role on directly (for the web client's sidebar).
    public func roots(for p: SharePrincipal) -> [(pageID: RecordID, role: ShareRole)] {
        switch p {
        case .owner: return []
        case .link(let l): return [(l.pageID, l.role)]
        case .user(let u):
            var best: [RecordID: ShareRole] = [:]
            for g in state.grants where g.userID == u.id { best[g.pageID] = max(best[g.pageID] ?? .view, g.role) }
            // Pages inside another root are reached through it.
            return best.filter { id, _ in !chain(of: .block(id), pending: [:]).dropFirst().contains { best[$0] != nil } }
                .map { ($0.key, $0.value) }.sorted { $0.pageID < $1.pageID }
        }
    }

    private func directRoles(for p: SharePrincipal) -> [RecordID: ShareRole] {
        switch p {
        case .owner: return [:]
        case .link(let l): return [l.pageID: l.role]
        case .user(let u):
            var out: [RecordID: ShareRole] = [:]
            for g in state.grants where g.userID == u.id { out[g.pageID] = max(out[g.pageID] ?? .view, g.role) }
            return out
        }
    }

    /// Where a record hangs in the page tree: its own block id first, then every ancestor block up to the top.
    /// `pending` lets a push be checked against records it creates itself (a new page with its content).
    func chain(of start: ParentRef, pending: [RecordKey: Record]) -> [RecordID] {
        var out: [RecordID] = []
        var cur: ParentRef? = start
        var guardCount = 0
        while let c = cur, guardCount < 512 {
            guardCount += 1
            switch c {
            case .workspace:
                cur = nil
            case .block(let id):
                out.append(id)
                if case .block(let b)? = pending[RecordKey(.block, id)] { cur = b.parent }
                else { cur = store.blocks[id]?.parent }
            case .database(let dbID):
                let db: Database?
                if case .database(let d)? = pending[RecordKey(.database, dbID)] { db = d } else { db = store.databases[dbID] }
                cur = db.map { .block($0.blockID) }
            }
        }
        return out
    }

    func chain(of record: Record, pending: [RecordKey: Record]) -> [RecordID] {
        switch record {
        case .block(let b): return [b.id] + chain(of: b.parent, pending: pending)
        case .database(let d): return chain(of: .block(d.blockID), pending: pending)
        case .view(let v): return chain(of: .block(v.blockID), pending: pending)
        case .workspace: return []
        }
    }

    public func role(of p: SharePrincipal, on record: Record, pending: [RecordKey: Record] = [:]) -> ShareRole? {
        if case .owner = p { return .full }
        if case .workspace = record { return nil }
        let direct = directRoles(for: p)
        guard !direct.isEmpty else { return nil }
        return chain(of: record, pending: pending).compactMap { direct[$0] }.max()
    }

    public func role(of p: SharePrincipal, onPage id: RecordID) -> ShareRole? {
        guard let b = store.blocks[id] else { return nil }
        return role(of: p, on: .block(b))
    }

    // MARK: Managing shares

    public struct CreatedLink: Sendable {
        public var link: SharingLink
        /// Shown once; only its hash is stored.
        public var secret: String
    }

    public func createLink(_ kind: SharingLink.Kind, pageID: RecordID, role: ShareRole, by p: SharePrincipal,
                           label: String? = nil, expiresAt: Date? = nil, uses: Int? = nil) throws -> CreatedLink {
        guard store.blocks[pageID] != nil else { throw ShareError.notFound }
        guard let mine = self.role(of: p, onPage: pageID), mine.canShare else { throw ShareError.forbidden("Sharing needs full access to the page.") }
        guard role <= mine else { throw ShareError.forbidden("You can't give more access than you have.") }
        if kind == .publish, role != .view { throw ShareError.invalid("Published pages are read-only.") }
        if kind == .access, role == .full { throw ShareError.invalid("Anonymous links can't have full access; use an invite.") }
        let secret = SecureToken.make(prefix: "bdl_")
        let link = SharingLink(id: SecureToken.make(bytes: 9), kind: kind, pageID: pageID, role: role, secretHash: Sha256.hex(secret),
                             label: label, createdAt: now(), expiresAt: expiresAt, usesLeft: kind == .invite ? uses : nil)
        state.links.append(link)
        save()
        return CreatedLink(link: link, secret: secret)
    }

    public func revokeLink(_ id: String, by p: SharePrincipal) throws {
        guard let i = state.links.firstIndex(where: { $0.id == id }) else { throw ShareError.notFound }
        guard role(of: p, onPage: state.links[i].pageID)?.canShare == true else { throw ShareError.forbidden("Needs full access.") }
        state.links[i].revokedAt = now()
        save()
    }

    /// Someone opened an invite and entered their name: they get an account, the role, and a device token.
    public func acceptInvite(secret: String, name: String) throws -> (user: ShareUser, token: String, pageID: RecordID) {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 80 else { throw ShareError.invalid("Enter your name.") }
        guard let l = link(secret: secret), l.kind == .invite else { throw ShareError.notFound }
        guard l.isActive(at: now()) else { throw ShareError.forbidden("This invite has expired or was revoked.") }
        let token = SecureToken.make(prefix: "bdu_", bytes: 32)
        let user = ShareUser(id: SecureToken.make(bytes: 9), name: clean, createdAt: now(), tokenHashes: [Sha256.hex(token)], lastSeen: now())
        state.users.append(user)
        state.grants.append(ShareGrant(id: SecureToken.make(bytes: 9), pageID: l.pageID, userID: user.id, role: l.role, createdAt: now()))
        if let i = state.links.firstIndex(where: { $0.id == l.id }) {
            state.links[i].lastUsed = now()
            if let u = state.links[i].usesLeft { state.links[i].usesLeft = u - 1 }
        }
        save()
        return (user, token, l.pageID)
    }

    /// Another device for an existing user (they're signed in on one and want the same access elsewhere).
    public func issueDeviceToken(for userID: String) throws -> String {
        guard let i = state.users.firstIndex(where: { $0.id == userID }) else { throw ShareError.notFound }
        let token = SecureToken.make(prefix: "bdu_", bytes: 32)
        state.users[i].tokenHashes.append(Sha256.hex(token))
        save()
        return token
    }

    public func setGrant(user userID: String, pageID: RecordID, role: ShareRole?, by p: SharePrincipal) throws {
        guard state.users.contains(where: { $0.id == userID }) else { throw ShareError.notFound }
        guard let mine = self.role(of: p, onPage: pageID), mine.canShare else { throw ShareError.forbidden("Sharing needs full access to the page.") }
        state.grants.removeAll { $0.userID == userID && $0.pageID == pageID }
        if let role {
            guard role <= mine else { throw ShareError.forbidden("You can't give more access than you have.") }
            state.grants.append(ShareGrant(id: SecureToken.make(bytes: 9), pageID: pageID, userID: userID, role: role, createdAt: now()))
        }
        save()
    }

    /// Everyone and every link with access to a page, including access inherited from pages above it.
    public func access(to pageID: RecordID) -> (grants: [ShareGrant], links: [SharingLink]) {
        let ids = Set(chain(of: .block(pageID), pending: [:]))
        return (state.grants.filter { ids.contains($0.pageID) }, state.links.filter { ids.contains($0.pageID) && $0.revokedAt == nil })
    }

    // MARK: Sync, filtered by role

    /// Everything the principal can see, for the first load (cheaper than paging the whole change log).
    public func snapshot(for p: SharePrincipal) -> SyncPage {
        let seq = (store.persistence as? ChangeLogging)?.lastChangeSeq ?? 0
        let records = store.allRecords().filter { canRead(p, $0) }
        return SyncPage(records: records, deletions: [], next: seq, more: false)
    }

    func canRead(_ p: SharePrincipal, _ r: Record) -> Bool {
        if case .owner = p { return true }
        if case .block(let b) = r, b.trashedAt != nil { return false }
        return role(of: p, on: r) != nil
    }

    /// The change log as the principal sees it. Changed records they can't (or can no longer) read are sent as
    /// deletions, so a page moved out of a shared area disappears from their copy.
    public func pullPage(for p: SharePrincipal, sync: SyncServer, after: Int64, limit: Int) -> SyncPage {
        let page = sync.pullPage(after: after, limit: limit)
        if case .owner = p { return page }
        var records: [Record] = [], deletions = page.deletions
        for r in page.records {
            if canRead(p, r) { records.append(r); continue }
            deletions.append(r.key)
            // A page that left the shared area takes its content with it: the content itself didn't change, so it
            // isn't in the log, but the guest's copy must drop it too (else it lingers as orphans).
            if case .block(let b) = r {
                for id in [b.id] + store.descendants(of: b.id) {
                    deletions.append(RecordKey(.block, id))
                    if let db = store.blocks[id]?.props.databaseID, store.databases[db]?.blockID == id {
                        deletions.append(RecordKey(.database, db))
                        for v in store.views.values where v.databaseID == db { deletions.append(RecordKey(.view, v.id)) }
                    }
                }
            }
        }
        var seen = Set<RecordKey>()
        deletions = deletions.filter { seen.insert($0).inserted }
        return SyncPage(records: records, deletions: deletions, next: page.next, more: page.more)
    }

    public struct PushResult: Sendable {
        public var reply: SyncPushReply
        public var rejected: [RecordKey]
    }

    /// Applies what the principal may change: edit (or full) access to where the record is now *and* to where it
    /// goes, no workspace record, nothing for view / comment roles. Rejected records come back as the server's
    /// copy so the client rolls back.
    public func push(for p: SharePrincipal, sync: SyncServer, _ body: SyncPush) -> PushResult {
        if case .owner = p { return PushResult(reply: sync.pushV2(body), rejected: []) }
        // Records created in this push can be parents of each other; existing records are judged where they are now
        // (a rejected move must not make its children look unshared).
        let pending = Dictionary(body.records.filter { store.record($0.key) == nil }.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        var allowed: [Record] = [], rejected: [RecordKey] = []
        for r in body.records {
            var destination = role(of: p, on: r, pending: pending)
            // Moving a block needs edit access where it lands (a shared page can't be moved out of the shared area).
            if case .block(let b) = r, let old = store.blocks[b.id], old.parent != b.parent {
                let direct = directRoles(for: p)
                destination = chain(of: b.parent, pending: pending).compactMap { direct[$0] }.max()
            }
            let current = store.record(r.key).map { role(of: p, on: $0) } ?? destination
            if destination?.canEdit == true, current?.canEdit == true { allowed.append(r) } else { rejected.append(r.key) }
        }
        var deletions: [RecordKey] = []
        for k in body.deletions {
            if let r = store.record(k), role(of: p, on: r)?.canEdit == true { deletions.append(k) } else { rejected.append(k) }
        }
        var reply = sync.pushV2(SyncPush(records: allowed, deletions: deletions))
        reply.newer += rejected.compactMap { k in store.record(k).flatMap { canRead(p, $0) ? $0 : nil } }
        return PushResult(reply: reply, rejected: rejected)
    }

    /// May the principal add a block after `blockID` (web client's Enter)?
    public func canInsert(after blockID: RecordID, by p: SharePrincipal) -> Bool {
        guard let b = store.blocks[blockID] else { return false }
        return role(of: p, on: .block(b))?.canEdit == true
    }
}
