#if os(macOS)
import AppKit
import BasedCore

/// Keyboard for selected blocks (Notion): ⌫ / ⌦ delete, esc clears, ↩ edits, ↑ ↓ move the selection (⇧ extends),
/// ⌘D duplicates. SwiftUI focus on the page was unreliable — after clicking ⋮⋮ nothing had keyboard focus and
/// Delete did nothing — so the page installs a local key monitor while it's on screen. It only acts when
/// blocks are selected and no text field is being edited.
@MainActor
final class BlockSelectionKeys {
    private var monitor: Any?
    private var mouseMonitor: Any?
    private weak var editor: EditorController?

    func install(_ editor: EditorController) {
        self.editor = editor
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, let ed = self.editor, self.handle(e, ed) else { return e }
            return nil
        }
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
            guard let self, let ed = self.editor, self.doubleClick(e, ed) else { return e }
            return nil
        }
    }

    func remove() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
        monitor = nil; mouseMonitor = nil
    }

    /// Double-click selects the block under the pointer — margins, dividers, images, embeds, page links and the
    /// chrome of code blocks and callouts included. Inside editable text a double-click keeps selecting a word.
    private func doubleClick(_ e: NSEvent, _ ed: EditorController) -> Bool {
        guard e.clickCount == 2, !ed.isLocked, ed.model.activeEditor === ed,
              let sv = ed.gutter.scrollView, e.window === sv.window, let p = ed.gutter.pointer else { return false }
        // Only over the page itself (not the sidebar, chat panel or a popover).
        let inScroll = sv.convert(e.locationInWindow, from: nil)
        guard sv.bounds.contains(inScroll) else { return false }
        if let hit = e.window?.contentView?.hitTest(e.locationInWindow), let tv = hit as? NSTextView, tv.isEditable { return false }
        guard let id = ed.block(at: p), let b = ed.store.blocks[id],
              ![.databaseInline, .table, .columnList, .column].contains(b.type) else { return false }
        ed.focusedID.flatMap { ed.host($0) }?.endEditing()
        e.window?.makeFirstResponder(nil)
        ed.selectedBlocks = [id]
        return true
    }

    private func handle(_ e: NSEvent, _ ed: EditorController) -> Bool {
        guard !ed.selectedBlocks.isEmpty, !ed.isLocked, ed.model.activeEditor === ed else { return false }
        // Typing in any text view / field (search, chat, a block) keeps its keys.
        if let r = e.window?.firstResponder, r is NSText { return false }
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        switch e.keyCode {
        case 51, 117:                                   // ⌫, ⌦
            ed.deleteSelection(); return true
        case 53:                                        // esc
            ed.selectedBlocks = []; return true
        case 36, 76:                                    // ↩
            guard ed.selectedBlocks.count == 1, let id = ed.selectedBlocks.first else { return false }
            ed.selectedBlocks = []
            ed.focusEnd(id); return true
        case 125, 126:                                  // ↓ ↑
            ed.moveBlockSelection(down: e.keyCode == 125, extend: mods.contains(.shift)); return true
        case 2 where mods == .command:                  // ⌘D
            ed.duplicateSelection(); return true
        default:
            return false
        }
    }
}

extension EditorController {
    /// ↑ / ↓ with blocks selected: move the selection to the neighbour (⇧ extends it), like Notion.
    func moveBlockSelection(down: Bool, extend: Bool) {
        let order = store.visibleOrder(in: pageID)
        let idx = selectedBlocks.compactMap { order.firstIndex(of: $0) }
        guard let lo = idx.min(), let hi = idx.max() else { return }
        let next = down ? hi + 1 : lo - 1
        guard order.indices.contains(next) else { return }
        if extend { selectedBlocks.insert(order[next]) } else { selectedBlocks = [order[next]] }
        scrollRequest = order[next]
    }
}
#endif
