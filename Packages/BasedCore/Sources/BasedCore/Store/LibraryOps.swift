import Foundation

// MARK: - Library (bulk management of every item in the workspace)

public enum LibraryKind: String, CaseIterable, Hashable, Sendable {
    case page = "Page", database = "Database", row = "Row", memory = "Memory", skill = "Skill", file = "File"
}

/// One row of the Library: a page, database, database row, memory, skill or uploaded file.
public struct LibraryItem: Identifiable, Hashable, Sendable {
    public var id: RecordID
    public var title: String
    public var kind: LibraryKind
    /// "Private", a teamspace name, or the parent page / database title.
    public var location: String
    /// Containing page or database block (nil at the top level).
    public var parentID: RecordID?
    public var section: SidebarSectionID?
    public var created: Date
    public var edited: Date
    public var isFavorite: Bool
}

public enum LibrarySort: String, CaseIterable, Sendable { case title = "Title", kind = "Type", location = "Location", edited = "Last edited", created = "Created" }

public enum LibraryDateFilter: String, CaseIterable, Sendable {
    case any = "Any time", today = "Today", week = "Past 7 days", month = "Past 30 days", older = "Older than 30 days"
    func matches(_ d: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(d)
        switch self {
        case .any: return true
        case .today: return Calendar.current.isDate(d, inSameDayAs: now)
        case .week: return age <= 7 * 86_400
        case .month: return age <= 30 * 86_400
        case .older: return age > 30 * 86_400
        }
    }
}

public enum LibraryLocationFilter: Hashable, Sendable {
    case any
    case topLevel
    case section(SidebarSectionID)
    /// Directly inside this page / database.
    case parent(RecordID)
}

public struct LibraryQuery: Sendable {
    public var text = ""
    public var kinds: Set<LibraryKind> = Set(LibraryKind.allCases)
    public var location: LibraryLocationFilter = .any
    public var edited: LibraryDateFilter = .any
    public var created: LibraryDateFilter = .any
    public var onlyDuplicateTitles = false
    public var sort: LibrarySort = .edited
    public var ascending = false
    public init() {}
}

/// Why several sidebar entries carry the same title (see `WorkspaceStore.duplicateTitleReport`).
public enum DuplicateCause: String, Sendable {
    /// The same record is listed more than once by the store's child index — a display bug.
    case listedTwice = "Same page listed twice (index bug)"
    /// Distinct pages that only share a title (e.g. one "Teamspace Home" per Notion teamspace).
    case distinctPages = "Different pages with the same title"
    /// Placeholders for Notion databases the integration couldn't read (linked views / unshared databases).
    case unreadableDatabase = "Placeholder for a database Notion didn't share"
    /// Copies with the same non-empty content (duplicated, or imported twice under new ids).
    case copies = "Copies with identical content"
}

public struct DuplicateGroup: Sendable {
    public var title: String
    public var ids: [RecordID]
    public var cause: DuplicateCause
}

@MainActor
public extension WorkspaceStore {

    /// Every live item, unsorted. Memories / skills are rows of the Agent Brain's databases.
    func libraryItems(memoriesDB: RecordID? = nil, skillsDB: RecordID? = nil) -> [LibraryItem] {
        let favorites = Set(workspace.favorites)
        var out: [LibraryItem] = []
        out.reserveCapacity(blocks.count / 8)
        var trashCache: [RecordID: Bool] = [:]
        func trashed(_ id: RecordID) -> Bool {
            if let v = trashCache[id] { return v }
            let v = isTrashed(id); trashCache[id] = v; return v
        }
        for b in blocks.values {
            let kind: LibraryKind
            switch b.type {
            case .databasePage: kind = .database
            case .databaseInline:
                guard ownsDatabase(b) else { continue }
                kind = .database
            case .page:
                if case .database(let did) = b.parent {
                    kind = did == memoriesDB ? .memory : did == skillsDB ? .skill : .row
                } else { kind = .page }
            case .file, .image, .pdf, .video, .audio:
                guard b.props.asset != nil else { continue }
                kind = .file
            default: continue
            }
            if trashed(b.id) { continue }
            let parentID: RecordID?
            let location: String
            var section: SidebarSectionID?
            switch b.parent {
            case .workspace:
                parentID = nil
                section = self.section(of: b)
                if case .teamspace(let t) = section! { location = teamspace(t)?.name ?? "Private" } else { location = "Private" }
            case .block, .database:
                let p = kind == .file ? containingPage(of: parentBlock(of: b.id)?.id ?? "") : parentBlock(of: b.id).flatMap { containingPageOrDatabase($0) }
                parentID = p
                location = p.map { title(of: $0) } ?? "—"
            }
            let name: String
            if kind == .file { name = b.props.asset?.name ?? "File" } else { name = title(of: b.id) }
            out.append(LibraryItem(id: b.id, title: name, kind: kind, location: location, parentID: parentID, section: section,
                                   created: b.createdAt, edited: b.updatedAt, isFavorite: favorites.contains(b.id)))
        }
        return out
    }

    /// Filters and sorts `items`.
    func filterLibrary(_ items: [LibraryItem], _ q: LibraryQuery, now: Date = Date()) -> [LibraryItem] {
        let text = q.text.trimmingCharacters(in: .whitespaces)
        var dupTitles: Set<String> = []
        if q.onlyDuplicateTitles {
            var seen: [String: Int] = [:]
            for i in items { seen[Self.titleKey(i.title), default: 0] += 1 }
            dupTitles = Set(seen.filter { $0.value > 1 }.keys)
        }
        var list = items.filter { i in
            guard q.kinds.contains(i.kind) else { return false }
            if !text.isEmpty && !i.title.localizedCaseInsensitiveContains(text) && !i.location.localizedCaseInsensitiveContains(text) { return false }
            switch q.location {
            case .any: break
            case .topLevel: if i.parentID != nil { return false }
            case .section(let s): if i.section != s { return false }
            case .parent(let p): if i.parentID != p { return false }
            }
            if !q.edited.matches(i.edited, now: now) || !q.created.matches(i.created, now: now) { return false }
            if q.onlyDuplicateTitles && !dupTitles.contains(Self.titleKey(i.title)) { return false }
            return true
        }
        let asc = q.ascending
        func cmp(_ a: String, _ b: String) -> ComparisonResult { a.localizedCaseInsensitiveCompare(b) }
        list.sort { a, b in
            let r: ComparisonResult
            switch q.sort {
            case .title: r = cmp(a.title, b.title)
            case .kind: r = a.kind.rawValue == b.kind.rawValue ? cmp(a.title, b.title) : cmp(a.kind.rawValue, b.kind.rawValue)
            case .location: r = a.location == b.location ? cmp(a.title, b.title) : cmp(a.location, b.location)
            case .edited: r = a.edited == b.edited ? .orderedSame : (a.edited < b.edited ? .orderedAscending : .orderedDescending)
            case .created: r = a.created == b.created ? .orderedSame : (a.created < b.created ? .orderedAscending : .orderedDescending)
            }
            if r == .orderedSame { return a.id < b.id }
            return asc ? r == .orderedAscending : r == .orderedDescending
        }
        if q.onlyDuplicateTitles && q.sort != .title {
            // Keep each duplicate group together.
            list.sort { Self.titleKey($0.title) < Self.titleKey($1.title) }
        }
        return list
    }

    // MARK: Duplicate diagnosis

    /// Ids listed more than once under the same parent by the child index (should always be empty).
    func childIndexDuplicates() -> [RecordID] {
        var out: [RecordID] = []
        var keys = Set(blocks.values.map(\.parent.key))
        keys.insert(ParentRef.workspace.key)
        for key in keys {
            guard let p = ParentRef(key: key) else { continue }
            var seen = Set<RecordID>()
            for id in children(of: p) where !seen.insert(id).inserted { out.append(id) }
        }
        return out
    }

    /// Groups sibling pages (same parent / sidebar section) that share a title, with the most likely cause.
    func duplicateTitleReport() -> [DuplicateGroup] {
        var groups: [DuplicateGroup] = []
        let listedTwice = Set(childIndexDuplicates())
        var parents: [ParentRef] = [.workspace]
        parents += blocks.values.filter { $0.type == .page && !isTrashed($0.id) }.map { .block($0.id) }
        for p in parents {
            let sibs: [Block] = p == .workspace ? topLevelPagesRaw() : subpages(of: p.id ?? "")
            var byTitle: [String: [Block]] = [:]
            for s in sibs { byTitle[Self.titleKey(title(of: s.id)), default: []].append(s) }
            for (_, list) in byTitle where list.count > 1 {
                let ids = list.map(\.id)
                let cause: DuplicateCause
                if Set(ids).count < ids.count || ids.contains(where: listedTwice.contains) { cause = .listedTwice }
                else if list.contains(where: isUnreadableDatabasePlaceholder) { cause = .unreadableDatabase }
                else if Set(list.map(contentFingerprint)).count == 1 && list.allSatisfy({ !children(of: .block($0.id)).isEmpty }) { cause = .copies }
                else { cause = .distinctPages }
                groups.append(DuplicateGroup(title: title(of: list[0].id), ids: ids, cause: cause))
            }
        }
        return groups.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    /// Top-level pages straight from the index (no de-duplication), for diagnosis.
    internal func topLevelPagesRaw() -> [Block] {
        children(of: .workspace).compactMap { blocks[$0] }.filter { $0.trashedAt == nil && $0.type.isPageLike }
    }

    /// Notion import keeps a 🗃️ page with no content where a database couldn't be read.
    internal func isUnreadableDatabasePlaceholder(_ b: Block) -> Bool {
        b.type == .page && b.props.icon == .emoji("🗃️") && b.props.databaseID == nil && children(of: .block(b.id)).isEmpty
    }

    internal func contentFingerprint(_ b: Block) -> String {
        let kids = childBlocks(of: .block(b.id)).prefix(20).map { "\($0.type.rawValue):\($0.text.plainText)" }
        return "\(b.type.rawValue)|\(b.props.databaseID == nil)|" + kids.joined(separator: "\u{1}")
    }

    internal func containingPageOrDatabase(_ b: Block) -> RecordID? {
        var cur: Block? = b
        var n = 0
        while let c = cur, n < 1000 {
            n += 1
            if c.type.isPageLike || (c.type == .databaseInline && ownsDatabase(c)) { return c.id }
            cur = parentBlock(of: c.id)
        }
        return nil
    }

    nonisolated static func titleKey(_ t: String) -> String { t.trimmingCharacters(in: .whitespaces).lowercased() }
}
