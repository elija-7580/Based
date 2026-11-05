import SwiftUI
import BasedCore

/// Menu-level editing commands routed to the focused page.
extension EditorController {
    /// Blocks a command applies to: the block selection, else the focused block.
    var targetBlocks: [RecordID] {
        if !selectedBlocks.isEmpty { return store.documentOrder(Array(selectedBlocks)) }
        if let f = focusedID, f != pageID { return [f] }
        return []
    }

    func turnTargets(into type: BlockType) {
        let ids = targetBlocks
        guard !ids.isEmpty else { return }
        let caret = focusedID.flatMap { host($0)?.selectedRange().location }
        store.turnInto(ids, type)
        if type == .page, ids.count == 1 { model.open(ids[0]); return }
        if let f = focusedID, let c = caret { focus(FocusTarget(f, c)) }
    }

    func duplicateTargets() {
        let ids = targetBlocks
        guard !ids.isEmpty else { return }
        let copies = store.duplicateBlocks(ids)
        if selectedBlocks.isEmpty, let first = copies.first { focusEnd(first) } else { selectedBlocks = Set(copies) }
    }

    func beginLinkEditing() {
        guard let id = focusedID, host(id)?.selectedRange().length ?? 0 > 0 else { return }
        linkEditor = id
    }

    /// ⌘⌥T: open all toggles if any is closed, else close all.
    func toggleAllToggles() {
        let ids = store.descendants(of: pageID, includeRows: false).filter { id in
            guard let b = store.blocks[id] else { return false }
            return b.type == .toggle || (b.type.isHeading && b.props.toggleable == true)
        }
        guard !ids.isEmpty else { return }
        let anyClosed = ids.contains { store.blocks[$0]?.props.isOpen != true }
        store.updateBlocks(ids, name: anyClosed ? "Expand toggles" : "Collapse toggles") { $0.props.isOpen = anyClosed }
    }

    func selectAllBlocks() {
        focusedID.flatMap { host($0) }?.endEditing()
        selectedBlocks = Set(store.contentBlocks(of: pageID).map(\.id))
    }

    func moveTargets(up: Bool) {
        for id in targetBlocks { up ? store.moveUp(id) : store.moveDown(id) }
        if let f = focusedID { focus(FocusTarget(f, host(f)?.selectedRange().location ?? 0)) }
    }
}
