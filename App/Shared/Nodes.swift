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
    var structureRevision = 0
}

@MainActor
final class Registry {
    let store: WorkspaceStore
    let workspace = WorkspaceNode()
    private var blocks: [RecordID: BlockNode] = [:]
    private var dbs: [RecordID: DatabaseNode] = [:]
    private var views: [RecordID: ViewNode] = [:]
    private var token: ObservationToken?

    init(store: WorkspaceStore) {
        self.store = store
        token = store.observe { [weak self] change in self?.apply(change) }
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
        for key in change.keys {
            switch key.kind {
            case .block:
                let b = store.blocks[key.id]
                if let n = blocks[key.id] {
                    let old = n.block
                    if old != b { n.block = b }
                    if old?.type != b?.type || old?.props.isOpen != b?.props.isOpen { structural = true }
                    if case .database(let d)? = old?.parent { dbs[d]?.revision += 1 }
                }
                if case .database(let d)? = b?.parent { dbs[d]?.revision += 1 }
                if b == nil || b?.type.isPageLike == true { structural = true }
            case .database:
                if let n = dbs[key.id] {
                    n.database = store.databases[key.id]
                    n.revision += 1
                }
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
        workspace.revision += 1
        if structural { workspace.structureRevision += 1 }
    }
}