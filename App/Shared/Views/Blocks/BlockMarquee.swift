#if os(macOS)
import SwiftUI
import AppKit
import BasedCore

/// Notion's mouse selection on a page: drag from the margin or a gap between blocks to draw a blue rectangle —
/// every block it touches is selected (⇧ / ⌘ add to the selection). Double-click beside or on a non-text block
/// selects it. Drags that start inside text keep selecting text (the text views take those clicks).
struct BlockMarqueeModifier: ViewModifier {
    let editor: EditorController
    @State private var base: Set<RecordID> = []

    /// Is `p` on the visible + / ⋮⋮ handle (clicks and drags there belong to the handle)?
    /// Reads main-actor gutter state, so it is main-actor isolated itself (it is only called from the gestures).
    @MainActor private func onHandle(_ p: CGPoint) -> Bool {
        guard let id = editor.gutter.hovered ?? editor.gutter.menuFor, let f = editor.gutter.frame(of: id) else { return false }
        return p.x >= f.minX - 48 && p.x < f.minX && p.y >= f.minY - 4 && p.y <= f.minY + 34
    }

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topLeading) {
                if let r = editor.marquee {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Theme.dropIndicator.opacity(0.12))
                        .overlay(RoundedRectangle(cornerRadius: 2).stroke(Theme.dropIndicator.opacity(0.5), lineWidth: 1))
                        .frame(width: r.width, height: r.height)
                        .offset(x: r.minX, y: r.minY)
                        .allowsHitTesting(false)
                }
            }
            // Margins and gaps have no content: without a shape they aren't hit-testable and drags there never
            // reached the gesture. Text views still take clicks on text (AppKit hit-testing goes to them first).
            .contentShape(Rectangle())
            .simultaneousGesture(
                DragGesture(minimumDistance: 6, coordinateSpace: BlockCanvas.space)
                    .onChanged { v in
                        #if DEBUG
                        if editor.marquee == nil { Log.notice("marquee start \(v.startLocation)", category: "debug") }
                        #endif
                        guard !editor.isLocked, !editor.gutter.isDragging, editor.gutter.menuFor == nil else { return }
                        if editor.marquee == nil {
                            // Not from the ⋮⋮ / + handle (that's a block drag).
                            if onHandle(v.startLocation) { return }
                            editor.focusedID.flatMap { editor.host($0) }?.endEditing()
                            let flags = NSEvent.modifierFlags
                            base = flags.contains(.shift) || flags.contains(.command) ? editor.selectedBlocks : []
                        }
                        let r = CGRect(x: min(v.startLocation.x, v.location.x), y: min(v.startLocation.y, v.location.y),
                                       width: abs(v.location.x - v.startLocation.x), height: abs(v.location.y - v.startLocation.y))
                        editor.marquee = r
                        editor.selectedBlocks = base.union(editor.blocks(intersecting: r))
                    }
                    .onEnded { _ in
                        if editor.marquee != nil {
                            withAnimation(.easeOut(duration: 0.15)) { editor.marquee = nil }
                        }
                    }
            )
            .simultaneousGesture(
                // A click in the margin / a gap clears the block selection (the column is hit-testable now, so the
                // page background's tap no longer gets these). Not on the + / ⋮⋮ handle.
                SpatialTapGesture(count: 1, coordinateSpace: BlockCanvas.space).onEnded { v in
                    // The second click of a double-click selects (BlockSelectionKeys) — don't clear it again.
                    guard (NSApp.currentEvent?.clickCount ?? 1) <= 1, !onHandle(v.location) else { return }
                    if !editor.selectedBlocks.isEmpty { editor.selectedBlocks = []; return }
                    // A click beside a text block (in the page margin, left or right of the row) puts the caret at the
                    // start / end of that block, so you don't have to hit the text itself. Clicks inside the row
                    // belong to the text view and never reach this point.
                    guard !editor.isLocked, let id = editor.block(at: v.location), let f = editor.gutter.frame(of: id),
                          let b = editor.store.blocks[id], b.type.isTextEditable else { return }
                    if v.location.x > f.maxX { editor.focus(FocusTarget(id, b.text.length)) }
                    else if v.location.x < f.minX { editor.focus(FocusTarget(id, 0)) }
                }
            )
    }
}

extension EditorController {
    /// Top-most selectable blocks whose row intersects `r` (canvas coordinates); children follow their parent.
    func blocks(intersecting r: CGRect) -> Set<RecordID> {
        var hit: [RecordID] = []
        for (id, f) in gutter.allFrames where f.intersects(r) { hit.append(id) }
        let ids = Set(hit)
        return ids.filter { id in !ids.contains { $0 != id && store.isDescendant(id, of: $0) } }
    }

    /// The block whose row is at `p`, or whose row is beside `p` (margins), for double-click selection.
    func block(at p: CGPoint) -> RecordID? {
        let rows = gutter.allFrames.filter { p.y >= $0.value.minY - 1 && p.y <= $0.value.maxY + 1 }
        // Innermost (smallest) row wins: a nested item rather than its parent.
        return rows.min { $0.value.width * $0.value.height < $1.value.width * $1.value.height }?.key
    }
}

extension View {
    func blockMarquee(_ editor: EditorController) -> some View { modifier(BlockMarqueeModifier(editor: editor)) }
}
#endif
