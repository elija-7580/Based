import SwiftUI
import Observation
import BasedCore
#if os(macOS)
import AppKit
#endif

/// The page's block canvas: every block row reports its frame in this space; the gutter overlay draws in it.
enum BlockCanvas {
    static let space = NamedCoordinateSpace.named("based.blockCanvas")
}

/// Notion-style gutter for one page (macOS): which block shows its + / ⋮⋮, the open block menu and a running
/// block drag. One page-level hover region and overlay instead of a hover area per row — the handle no longer
/// disappears on the way to it, and dragging no longer depends on drag & drop between text views.
///
/// Rows register their frames (`register`) without being observed, so pointer moves only re-render the overlay.
@MainActor @Observable
final class BlockGutterState {
    @ObservationIgnored private(set) var frames: [RecordID: CGRect] = [:]
    @ObservationIgnored private var noHandle: Set<RecordID> = []
    /// Frames with handles as an array for hit-testing; rebuilt only after a row registers a new frame (not on every pointer move).
    @ObservationIgnored private var hoverList: [(id: RecordID, frame: CGRect)]?
    /// Block whose + / ⋮⋮ is visible.
    var hovered: RecordID?
    /// Block whose ⋮⋮ menu is open (keeps the handle in place).
    var menuFor: RecordID?
    /// Blocks being dragged (rows read this to dim themselves; set once per drag).
    private(set) var draggingIDs: [RecordID] = []
    /// Pointer while dragging, in canvas coordinates.
    private(set) var dragPoint: CGPoint?
    private(set) var dropTarget: BlockDropTarget?
    private(set) var ghostTitle = ""
    @ObservationIgnored private var grabOffset: CGFloat = 0
    @ObservationIgnored private var rows: [BlockLayoutRow] = []
    /// Recomputes drop rows (blocks rendered while auto-scrolling a lazy page become targets).
    @ObservationIgnored var rowsProvider: (() -> [BlockLayoutRow])?
    /// Horizontal extent of the blocks; dropping far outside it (sidebar, other pane) cancels the drag.
    @ObservationIgnored private var extent: ClosedRange<CGFloat> = 0...0
    @ObservationIgnored private var clearTask: Task<Void, Never>?
    #if os(macOS)
    @ObservationIgnored weak var scrollView: NSScrollView? { didSet { observeLiveScroll() } }
    @ObservationIgnored private var scrollObserver: NSObjectProtocol?
    /// Time of the last live-scroll frame: pointer hover work is skipped while the page is scrolling.
    @ObservationIgnored private var lastLiveScroll: TimeInterval = 0
    @ObservationIgnored private var autoScrollTimer: Timer?
    /// Last pointer position over the page (canvas coordinates), for double-click selection.
    @ObservationIgnored var pointer: CGPoint?
    #endif

    #if os(macOS)
    private var isLiveScrolling: Bool { ProcessInfo.processInfo.systemUptime - lastLiveScroll < 0.1 }

    private func observeLiveScroll() {
        if let o = scrollObserver { NotificationCenter.default.removeObserver(o); scrollObserver = nil }
        guard let sv = scrollView else { return }
        scrollObserver = NotificationCenter.default.addObserver(forName: NSScrollView.didLiveScrollNotification, object: sv, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.lastLiveScroll = ProcessInfo.processInfo.systemUptime }
        }
    }
    #endif

    var isDragging: Bool { !draggingIDs.isEmpty }
    private var isPinned: Bool { menuFor != nil || isDragging }

    func frame(of id: RecordID) -> CGRect? { frames[id] }

    func register(_ id: RecordID, frame: CGRect, showsHandle: Bool) {
        if frames[id] != frame || noHandle.contains(id) == showsHandle { hoverList = nil }
        frames[id] = frame
        if showsHandle { noHandle.remove(id) } else { noHandle.insert(id) }
    }

    func unregister(_ id: RecordID) {
        hoverList = nil
        frames[id] = nil
        noHandle.remove(id)
        if hovered == id, !isPinned { hovered = nil }
    }

    // MARK: Hover

    func hover(_ phase: HoverPhase, locked: Bool) {
        guard !isPinned else { return }
        guard !locked else { if hovered != nil { hovered = nil }; return }
        #if os(macOS)
        // While the page scrolls, blocks stream under a parked pointer; resolving a handle for each is wasted work.
        if case .active = phase, isLiveScrolling { return }
        #endif
        switch phase {
        case .active(let p):
            #if os(macOS)
            pointer = p
            #endif
            let list: [(id: RecordID, frame: CGRect)]
            if let cached = hoverList { list = cached } else {
                list = frames.compactMap { noHandle.contains($0.key) ? nil : (id: $0.key, frame: $0.value) }
                hoverList = list
            }
            if let id = BlockGutterGeometry.hoverTarget(at: p, frames: list, slack: Theme.blockSpacing / 2 + 1) {
                clearTask?.cancel(); clearTask = nil
                if hovered != id { hovered = id }
            } else {
                scheduleClear()
            }
        case .ended:
            scheduleClear()
        }
    }

    /// A short grace period: crossing a gap between blocks or leaving for a moment doesn't flicker the handle.
    private func scheduleClear() {
        guard hovered != nil, clearTask == nil else { return }
        clearTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(220))
            guard let self, !Task.isCancelled else { return }
            self.clearTask = nil
            if !self.isPinned { self.hovered = nil }
        }
    }

    /// Typing hides the handle until the pointer moves again (as in Notion).
    func hideWhileTyping() {
        if !isPinned, hovered != nil { hovered = nil }
    }

    // MARK: Drag

    func startDrag(ids: [RecordID], grabOffset: CGFloat, rows: [BlockLayoutRow], title: String, at p: CGPoint) {
        clearTask?.cancel(); clearTask = nil
        draggingIDs = ids
        self.grabOffset = grabOffset
        self.rows = rows
        let minX = rows.map(\.frame.minX).min() ?? 0, maxX = rows.map(\.frame.maxX).max() ?? 0
        extent = (minX - 120)...(max(minX, maxX) + 120)
        ghostTitle = title
        updateDrag(p)
        #if os(macOS)
        startAutoScroll()
        #endif
    }

    func updateDrag(_ p: CGPoint) {
        guard isDragging else { return }
        dragPoint = p
        guard extent.contains(p.x) else { if dropTarget != nil { dropTarget = nil }; return }
        let t = BlockGutterGeometry.dropTarget(at: p, blockLeft: p.x - grabOffset, rows: rows,
                                               indent: Theme.indent, spacing: Theme.blockSpacing)
        if t != dropTarget { dropTarget = t }
    }

    /// Ends the drag; returns what to move where (nil when cancelled / nowhere to drop).
    func endDrag() -> (ids: [RecordID], target: BlockDropTarget)? {
        let result = dropTarget.map { (ids: draggingIDs, target: $0) }
        draggingIDs = []
        dragPoint = nil
        dropTarget = nil
        rows = []
        rowsProvider = nil
        hovered = nil
        #if os(macOS)
        autoScrollTimer?.invalidate(); autoScrollTimer = nil
        #endif
        return result
    }

    #if os(macOS)
    /// Scrolls the page while the pointer is near the top or bottom edge during a drag.
    private func startAutoScroll() {
        autoScrollTimer?.invalidate()
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoScrollTick() }
        }
        RunLoop.main.add(t, forMode: .common)
        autoScrollTimer = t
    }

    private func autoScrollTick() {
        guard isDragging, let sv = scrollView, let window = sv.window, let doc = sv.documentView else { return }
        let local = sv.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        let h = sv.bounds.height
        let fromTop = sv.isFlipped ? local.y : h - local.y
        let fromBottom = h - fromTop
        let zone: CGFloat = 48
        var speed: CGFloat = 0
        if fromTop < zone { speed = -min(24, (zone - max(fromTop, -zone)) / 2.5) }
        else if fromBottom < zone { speed = min(24, (zone - max(fromBottom, -zone)) / 2.5) }
        guard speed != 0 else { return }
        let clip = sv.contentView
        var origin = clip.bounds.origin
        let maxY = max(0, doc.frame.height - clip.bounds.height)
        let before = origin.y
        // Flipped document (SwiftUI's): larger y = further down.
        origin.y = doc.isFlipped ? min(maxY, max(0, origin.y + speed)) : min(maxY, max(0, origin.y - speed))
        guard origin.y != before else { return }
        clip.scroll(to: origin)
        sv.reflectScrolledClipView(clip)
        let moved = doc.isFlipped ? origin.y - before : before - origin.y
        if let fresh = rowsProvider?() { rows = fresh }
        if let p = dragPoint { updateDrag(CGPoint(x: p.x, y: p.y + moved)) }
    }
    #endif
}

// MARK: - Editor actions

extension EditorController {
    /// Blocks a handle acts on: the selection when the block is part of it, else the block (top-most only).
    func handleTargets(_ id: RecordID) -> [RecordID] {
        guard selectedBlocks.contains(id) else { return [id] }
        let ids = store.documentOrder(Array(selectedBlocks))
        return ids.filter { i in !ids.contains { $0 != i && store.isDescendant(i, of: $0) } }
    }

    func beginBlockDrag(from id: RecordID, start: CGPoint, at p: CGPoint) {
        guard !isLocked, store.blocks[id] != nil else { return }
        let ids = handleTargets(id)
        focusedID.flatMap { host($0) }?.endEditing()
        menu = nil
        gutter.menuFor = nil
        if !selectedBlocks.contains(id) { selectedBlocks = [] }
        let title = store.blocks[id].map { b -> String in
            let t = b.text.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? b.type.displayName : String(t.prefix(60))
        } ?? ""
        let left = gutter.frame(of: id)?.minX ?? start.x
        gutter.rowsProvider = { [weak self] in self?.dropRows(excluding: ids) ?? [] }
        gutter.startDrag(ids: ids, grabOffset: start.x - left, rows: dropRows(excluding: ids),
                         title: ids.count > 1 ? "\(ids.count) blocks" : title, at: p)
        Log.breadcrumb("drag blocks ×\(ids.count)")
    }

    func finishBlockDrag() {
        guard let drop = gutter.endDrag(), !isLocked else { return }
        let ids = drop.ids
        switch drop.target.placement {
        case .before(let t):
            guard let tb = store.blocks[t] else { return }
            store.moveBlocks(ids, to: tb.parent, at: .before(t))
        case .after(let t):
            guard let tb = store.blocks[t] else { return }
            store.moveBlocks(ids, to: tb.parent, at: .after(t))
        case .firstChild(let t):
            store.moveBlocks(ids, to: .block(t), at: .start)
        case .column(let t, let leading):
            store.placeInColumn(ids, beside: t, leading: leading)
        }
        selectedBlocks = Set(ids)
    }

    /// Everything a drop can land next to: all rendered blocks except the dragged ones and their descendants.
    func dropRows(excluding ids: [RecordID]) -> [BlockLayoutRow] {
        let moving = Set(ids)
        var out: [BlockLayoutRow] = []
        for (rid, f) in gutter.allFrames {
            guard let b = store.blocks[rid], b.trashedAt == nil, b.type != .column, !moving.contains(rid),
                  !ids.contains(where: { store.isDescendant(rid, of: $0) }) else { continue }
            var parent: RecordID?
            var pageLevel = true
            var siblings: [RecordID] = []
            if case .block(let pid) = b.parent, let p = store.blocks[pid] {
                siblings = store.contentBlocks(of: pid).map(\.id).filter { !moving.contains($0) }
                if p.type != .page, p.type != .databasePage, p.type != .column { parent = pid; pageLevel = false }
            }
            let kids = store.contentBlocks(of: rid).contains { !moving.contains($0.id) }
            let canNest: Bool = {
                switch b.type {
                case .text, .bulletedList, .numberedList, .todo, .toggle, .quote, .callout: return true
                default: return b.type.isHeading && b.props.toggleable == true
                }
            }()
            out.append(BlockLayoutRow(id: rid, frame: f, parent: parent, isLastChild: siblings.last == rid,
                                      canNest: canNest, childrenBelow: kids && BlockRow.rendersChildrenBelow(b, store: store),
                                      allowsColumns: pageLevel && b.type != .columnList))
        }
        return out
    }

    /// + : an empty text line becomes the "/" prompt in place; otherwise a new line below (⌥: above).
    func addFromGutter(_ id: RecordID, above: Bool) {
        guard !isLocked, let b = store.blocks[id] else { return }
        gutter.hovered = nil
        if !above, b.type == .text, b.text.isEmpty {
            store.setText(id, RichText("/"))
            menu = InlineMenu(kind: .slash, blockID: id, anchor: 0, query: "")
            focus(FocusTarget(id, 1))
            return
        }
        let nid = above ? store.insertBlock(.text, text: RichText("/"), in: b.parent, at: .before(id))
                        : (store.insertBlock(.text, after: id, text: RichText("/")) ?? id)
        menu = InlineMenu(kind: .slash, blockID: nid, anchor: 0, query: "")
        focus(FocusTarget(nid, 1))
    }

    /// ⋮⋮ click: select the block (keeping a selection it belongs to) and open its menu. ⇧-click toggles selection.
    func clickHandle(_ id: RecordID, shift: Bool) {
        if shift { selectedBlocks.formSymmetricDifference([id]); return }
        focusedID.flatMap { host($0) }?.endEditing()
        // A table cell (or other inline text view) may still hold the caret; ⌫ / Entf must reach the selection.
        #if os(macOS)
        if let w = NSApp.keyWindow, w.firstResponder is NSTextView { w.makeFirstResponder(nil) }
        #endif
        if !selectedBlocks.contains(id) { selectedBlocks = [id] }
        gutter.menuFor = id
    }
}

extension BlockGutterState {
    var allFrames: [RecordID: CGRect] { frames }
}

// MARK: - Overlay (macOS)

#if os(macOS)
/// Draws the hovered block's + / ⋮⋮, the blue drop line and the drag ghost on top of the page's blocks.
struct BlockGutterOverlay: View {
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        let g = editor.gutter
        ZStack(alignment: .topLeading) {
            if let id = g.hovered ?? g.menuFor, let f = g.frame(of: id), let b = model.store.blocks[id], !editor.isLocked {
                GutterHandle(block: b, editor: editor)
                    .offset(x: f.minX - 45, y: f.minY + handleOffset(b))
                    .opacity(g.isDragging ? 0 : 1)
                    .id(id)
                    .transition(.opacity.animation(.easeOut(duration: 0.1)))
            }
            if let t = g.dropTarget {
                RoundedRectangle(cornerRadius: 1.5)
                    // Notion's drop line: always a clear blue (the system accent may be graphite → invisible).
                    .fill(Theme.dropIndicator)
                    .frame(width: t.indicator.width, height: t.indicator.height)
                    .offset(x: t.indicator.minX, y: t.indicator.minY)
                    .allowsHitTesting(false)
                    .animation(.spring(response: 0.18, dampingFraction: 0.85), value: t.indicator)
            }
            if g.isDragging, let p = g.dragPoint {
                Text(g.ghostTitle)
                    .font(DS.Text.body())
                    .lineLimit(1)
                    .padding(.horizontal, DS.Space.md).padding(.vertical, DS.Space.xs)
                    .frame(maxWidth: 320, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 5).fill(.regularMaterial))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.primary.opacity(0.08)))
                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                    .opacity(0.72)
                    // Below-right of the pointer, so the line and the text it targets stay visible.
                    .offset(x: p.x + 16, y: p.y + 10)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func handleOffset(_ b: Block) -> CGFloat {
        let line = Theme.lineHeight(for: b.type, format: editor.format)
        return max(0, (line - 24) / 2) + (b.type.isHeading ? 6 : 0) + (b.type == .heading1 ? 10 : 0)
    }
}

/// + and ⋮⋮ for one block. ⋮⋮: click → menu, drag → move (one gesture, so a click never starts a drag).
private struct GutterHandle: View {
    let block: Block
    let editor: EditorController
    @State private var hoverPlus = false
    @State private var hoverGrip = false

    var body: some View {
        HStack(spacing: 1) {
            Button {
                editor.addFromGutter(block.id, above: NSEvent.modifierFlags.contains(.option))
            } label: {
                Image(systemName: "plus")
                    .font(DS.Text.ui())
                    .frame(width: 22, height: 24)
                    .background(RoundedRectangle(cornerRadius: DS.Radius.small).fill(Color.primary.opacity(hoverPlus ? 0.08 : 0)))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hoverPlus = $0 }
            .help("Click to add below\nOption-click to add above")
            .accessibilityIdentifier("block.add")

            GripDots()
                .frame(width: 18, height: 24)
                .background(RoundedRectangle(cornerRadius: DS.Radius.small).fill(Color.primary.opacity(hoverGrip ? 0.08 : 0)))
                .contentShape(Rectangle())
                .onHover { hoverGrip = $0 }
                .gesture(
                    DragGesture(minimumDistance: 0, coordinateSpace: BlockCanvas.space)
                        .onChanged { v in
                            if !editor.gutter.isDragging {
                                guard hypot(v.translation.width, v.translation.height) > 3 else { return }
                                editor.beginBlockDrag(from: block.id, start: v.startLocation, at: v.location)
                            } else {
                                editor.gutter.updateDrag(v.location)
                            }
                        }
                        .onEnded { _ in
                            if editor.gutter.isDragging { editor.finishBlockDrag() }
                            else { editor.clickHandle(block.id, shift: NSEvent.modifierFlags.contains(.shift)) }
                        }
                )
                .help("Drag to move\nClick to open menu")
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel("Block menu")
                .accessibilityAction(named: "Open block menu") { editor.clickHandle(block.id, shift: false) }
                .accessibilityIdentifier("block.handle")
                .panelPopover(isPresented: menuBinding, arrowEdge: .leading) {
                    BlockMenuView(ids: editor.handleTargets(block.id), editor: editor) { editor.gutter.menuFor = nil }
                        .arrowlessPopover()
                }
        }
        .foregroundStyle(Theme.secondary)
    }

    private var menuBinding: Binding<Bool> {
        Binding(get: { editor.gutter.menuFor == block.id },
                set: { if !$0, editor.gutter.menuFor == block.id { editor.gutter.menuFor = nil } })
    }
}

/// Notion's drag handle: six dots in two columns (drawn, so it never depends on an SF Symbol being present).
struct GripDots: View {
    var body: some View {
        Canvas { ctx, size in
            let d: CGFloat = 3, gapX: CGFloat = 3, gapY: CGFloat = 3
            let w = d * 2 + gapX, h = d * 3 + gapY * 2
            let x0 = (size.width - w) / 2, y0 = (size.height - h) / 2
            for col in 0..<2 {
                for row in 0..<3 {
                    let r = CGRect(x: x0 + CGFloat(col) * (d + gapX), y: y0 + CGFloat(row) * (d + gapY), width: d, height: d)
                    ctx.fill(Path(ellipseIn: r), with: .foreground)
                }
            }
        }
    }
}

/// Finds the NSScrollView around the page (for auto-scrolling while dragging blocks).
struct EnclosingScrollViewReader: NSViewRepresentable {
    let found: (NSScrollView?) -> Void
    func makeNSView(context: Context) -> ProbeView { let v = ProbeView(); v.found = found; return v }
    func updateNSView(_ v: ProbeView, context: Context) { v.found = found }

    final class ProbeView: NSView {
        var found: ((NSScrollView?) -> Void)?
        /// Never takes clicks from the page.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let sv = enclosingScrollView
            DispatchQueue.main.async { [weak self] in self?.found?(sv) }
        }
    }
}
#endif
