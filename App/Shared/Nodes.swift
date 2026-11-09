import SwiftUI
import Observation
import BasedCore

/// Fine-grained observable mirrors of store records, so a keystroke only re-renders its own block.
@MainActor @Observable
final class BlockNode {
    let id: RecordID
    var block: Block?
    var children: [RecordID] = []
    var viewIDs: [RecordID] = []
    /// Bumped when a child's type or open state changes (list numbering, toggles) — lets a block list
    /// re-render for its own children instead of on every structural change in the workspace.
    var childRevision = 0
    init(id: RecordID) { self.id = id }
}

@MainActor @Observable
final class DatabaseNode {
    let id: RecordID
    var database: Database?
    /// Bumped whenever the schema or any row changes.
    var revision = 0
    init(id: RecordID) { self.id = id }
}

@MainActor @Observable
final class ViewNode {
    let id: RecordID
    var view: DatabaseView?
    init(id: RecordID) { self.id = id }
}

@MainActor @Observable
final class WorkspaceNode {
    /// Bumped on every change (sidebar, search, trash).
    var revision = 0
    /// BSD-117: bumped when the page tree changes (pages added / moved / trashed, type or open state, favorites,
    /// teamspaces) — not when a page's title or icon changes, so typing a title doesn't re-render the sidebar,
    /// tab strip, outline or breadcrumbs.
    var structureRevision = 0
    /// BSD-117: bumped when a page's title or icon (or a database's name) changes. Views that list many titles
    /// without observing each page's node (Trash, Home chooser) read this; single titles observe their node
    /// via `Registry.observeTitle`.
    var pageMetaRevision = 0
    /// Lower-cased titles used by more than one top-level page (sidebar tooltips). Kept here so the sidebar
    /// re-renders only when the set changes, not on every title keystroke.
    var duplicateTitles: Set<String> = []
}

@MainActor
final class Registry {
    let store: WorkspaceStore
    let workspace = WorkspaceNode()
    private var blocks: [RecordID: BlockNode] = [:]
    private var dbs: [RecordID: DatabaseNode] = [:]
    private var views: [RecordID: ViewNode] = [:]
    private var token: ObservationToken?
    /// `store.hierarchyRevision` as of the last applied change set (BSD-117).
    private var seenHierarchyRevision: Int

    init(store: WorkspaceStore) {
        self.store = store
        seenHierarchyRevision = store.hierarchyRevision
        workspace.duplicateTitles = Self.duplicateTitles(store.topLevelPages(), store: store)
        token = store.observe { [weak self] change in self?.apply(change) }
    }

    /// BSD-117: registers observation of everything `store.title(of:)` / `store.icon(of:)` read for `id` — the
    /// page's node and, for a database page, its database — so a view showing one title re-renders only when
    /// that title changes (instead of reading `workspace.structureRevision`).
    func observeTitle(_ id: RecordID?) {
        guard let id else { return }
        let n = block(id)
        if let db = n.block?.props.databaseID { _ = database(db).database }
    }

    func observeTitle(of item: SidebarItem?) {
        switch item {
        case .page(let id)?: observeTitle(id)
        case .chat(let id?)?: observeTitle(id)
        default: break
        }
    }

    /// Lower-cased titles used by more than one of `pages`.
    static func duplicateTitles(_ pages: [Block], store: WorkspaceStore) -> Set<String> {
        var count: [String: Int] = [:]
        for p in pages { count[store.title(of: p.id).trimmingCharacters(in: .whitespaces).lowercased(), default: 0] += 1 }
        return Set(count.filter { $0.value > 1 }.keys)
    }

    func block(_ id: RecordID) -> BlockNode {
        if let n = blocks[id] { return n }
        let n = BlockNode(id: id)
        n.block = store.blocks[id]
        n.children = store.contentBlocks(of: id).map(\.id)
        n.viewIDs = store.viewIDs(forBlock: id)
        blocks[id] = n
        return n
    }

    func database(_ id: RecordID) -> DatabaseNode {
        if let n = dbs[id] { return n }
        let n = DatabaseNode(id: id)
        n.database = store.databases[id]
        dbs[id] = n
        return n
    }

    func view(_ id: RecordID) -> ViewNode {
        if let n = views[id] { return n }
        let n = ViewNode(id: id)
        n.view = store.views[id]
        views[id] = n
        return n
    }

    private func apply(_ change: ChangeSet) {
        var structural = false
        var pageMeta = false
        var topLevelMeta = false
        for key in change.keys {
            switch key.kind {
            case .block:
                let b = store.blocks[key.id]
                if let n = blocks[key.id] {
                    let old = n.block
                    if old != b { n.block = b }
                    if old?.type != b?.type || old?.props.isOpen != b?.props.isOpen {
                        structural = true
                        if case .block(let p)? = b?.parent ?? old?.parent { blocks[p]?.childRevision += 1 }
                    }
                    if case .database(let d)? = old?.parent { dbs[d]?.revision += 1 }
                }
                if case .database(let d)? = b?.parent { dbs[d]?.revision += 1 }
                // BSD-117: a page's title / icon is page metadata; existence, parent, order, type and trash state
                // are caught by `store.hierarchyRevision` below.
                if let b, b.type.isPageLike {
                    pageMeta = true
                    if b.parent == .workspace { topLevelMeta = true }
                }
            case .database:
                if let n = dbs[key.id] {
                    n.database = store.databases[key.id]
                    n.revision += 1
                }
                pageMeta = true
                topLevelMeta = true
                // relations/rollups may depend on other databases
                for (_, d) in dbs where d.id != key.id { d.revision += 1 }
            case .view:
                views[key.id]?.view = store.views[key.id]
            case .workspace:
                structural = true
            }
        }
        for p in change.parents {
            structural = true
            if p.hasPrefix("b:") {
                let id = String(p.dropFirst(2))
                if let n = blocks[id] {
                    let kids = store.contentBlocks(of: id).map(\.id)
                    if kids != n.children { n.children = kids }
                    let v = store.viewIDs(forBlock: id)
                    if v != n.viewIDs { n.viewIDs = v }
                }
            } else if p.hasPrefix("d:") {
                dbs[String(p.dropFirst(2))]?.revision += 1
            }
        }
        if store.hierarchyRevision != seenHierarchyRevision {
            seenHierarchyRevision = store.hierarchyRevision
            structural = true
        }
        workspace.revision += 1
        if structural { workspace.structureRevision += 1 }
        if pageMeta { workspace.pageMetaRevision += 1 }
        if structural || topLevelMeta {
            let dupes = Self.duplicateTitles(store.topLevelPages(), store: store)
            if dupes != workspace.duplicateTitles { workspace.duplicateTitles = dupes }
        }
    }
}