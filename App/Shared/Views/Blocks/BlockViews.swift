import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Where the inline (slash / mention) menu should appear.
struct MenuAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = value ?? nextValue()
    }
}

enum DropEdge { case top, bottom, left, right }

/// The children of a block (or page), in order.
struct BlockList: View {
    let parentID: RecordID
    let editor: EditorController
    var listDepth = 0
    /// Top level of a page: render lazily once the page is long (each block owns a text view; a 244-block
    /// page took ~450 ms to open when every row was built up front).
    var lazyWhenLong = false
    static let lazyThreshold = 60
    @Environment(AppModel.self) private var model

    var body: some View {
        let node = model.registry.block(parentID)
        // Only this list's own children matter (order via `children`, numbering via `childRevision`); reading the
        // workspace-wide structure revision re-rendered every list on the page for each page-title keystroke.
        let _ = node.childRevision
        let ids = node.children
        let numbers = listNumbers(ids)
        if lazyWhenLong && ids.count > Self.lazyThreshold {
            LazyVStack(alignment: .leading, spacing: Theme.blockSpacing) { rows(ids, numbers) }
        } else {
            // Moves, inserts and deletes slide into place (Notion animates reordering) instead of jumping.
            VStack(alignment: .leading, spacing: Theme.blockSpacing) { rows(ids, numbers) }
                .animation(.spring(response: 0.32, dampingFraction: 0.88), value: ids)
        }
    }

    private func rows(_ ids: [RecordID], _ numbers: [RecordID: Int]) -> some View {
        ForEach(ids, id: \.self) { id in
            BlockRow(id: id, editor: editor, number: numbers[id], listDepth: listDepth)
                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: -3)), removal: .opacity))
        }
    }

    /// Numbered lists restart after any other block.
    private func listNumbers(_ ids: [RecordID]) -> [RecordID: Int] {
        var out: [RecordID: Int] = [:]
        var n = 0
        for id in ids {
            if model.store.blocks[id]?.type == .numberedList { n += 1; out[id] = n } else { n = 0 }
        }
        return out
    }
}

struct BlockRow: View {
    let id: RecordID
    let editor: EditorController
    var number: Int?
    var listDepth = 0
    @Environment(AppModel.self) private var model
    #if os(iOS)
    @State private var showMenu = false
    @State private var dropEdge: DropEdge?
    /// Last measured size, read by the drop delegate. A plain box (not observed) so resizing doesn't re-render.
    @State private var geometry = SizeBox()
    #endif

    var body: some View {
        let node = model.registry.block(id)
        if let b = node.block, b.trashedAt == nil {
            content(b, node: node)
        }
    }

    private var store: WorkspaceStore { model.store }
    /// Width of the + / ⋮⋮ gutter left of every block (inside the page's horizontal padding).
    static let gutter: CGFloat = 44

    /// Children render as rows right below the block (not inside it like callouts, quotes and columns).
    static func rendersChildrenBelow(_ b: Block, store: WorkspaceStore) -> Bool {
        guard store.showsChildrenInline(b) else { return false }
        switch b.type {
        case .columnList, .column, .syncedBlock, .callout, .quote, .button: return false
        default: return true
        }
    }
    private func rendersChildrenBelow(_ b: Block) -> Bool { Self.rendersChildrenBelow(b, store: store) }

    @ViewBuilder
    private func content(_ b: Block, node: BlockNode) -> some View {
        let selected = editor.selectedBlocks.contains(id)
        let menuHere = editor.menu?.blockID == id || editor.aiPrompt == id
        let nested = b.type.isList ? listDepth + 1 : listDepth
        VStack(alignment: .leading, spacing: Theme.blockSpacing) {
            HStack(alignment: .top, spacing: 4) {
                BlockMarker(block: b, editor: editor, number: number, depth: listDepth)
                BlockContent(block: b, editor: editor)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, b.type.isHeading ? 6 : 0)
            // A coloured background gets a little inset so text and the toggle arrow don't touch its edge.
            .padding(.horizontal, hasFill(b) ? 8 : 0)
            .padding(.vertical, hasFill(b) && !b.type.isHeading ? 2 : 0)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(background(b)))
            .padding(.top, b.type == .heading1 ? 10 : 0)
            .anchorPreference(key: MenuAnchorKey.self, value: .bounds) { menuHere ? $0 : nil }
            #if os(macOS)
            // The page-level gutter (BlockGutter.swift) hit-tests these frames for the + / ⋮⋮ and for drops.
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: BlockCanvas.space) }) { f in
                editor.gutter.register(id, frame: f, showsHandle: b.type != .columnList)
            }
            .onDisappear { editor.gutter.unregister(id) }
            #else
            .overlay(alignment: .topLeading) { handle(b) }
            #endif
            if rendersChildrenBelow(b), !node.children.isEmpty {
                BlockList(parentID: id, editor: editor, listDepth: nested)
                    .padding(.leading, Theme.indent)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: -4)), removal: .opacity))
            }
        }
        // Selection tints the whole block — its own background (code, callout) and nested children included — like
        // Notion's translucent blue wash, instead of replacing the background (which hid code blocks).
        .overlay {
            RoundedRectangle(cornerRadius: 4)
                .fill(Theme.dropIndicator.opacity(selected ? 0.16 : 0))
                .padding(.horizontal, -3)
                .allowsHitTesting(false)
                .animation(.easeOut(duration: 0.14), value: selected)
        }
        .id(b.id)
        #if os(macOS)
        .opacity(editor.gutter.draggingIDs.contains(id) ? 0.35 : 1)
        .contentShape(Rectangle())
        #else
        .overlay(alignment: dropAlignment) { dropIndicator }
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { geometry.size = $0 })
        .contentShape(Rectangle())
        .onDrop(of: [.text], delegate: BlockDropDelegate(target: b, model: model, editor: editor, box: geometry, edge: $dropEdge))
        #endif
        .contextMenu { BlockMenuItems(ids: menuTargets, editor: editor) }
        .popover(isPresented: linkBinding) { LinkEditorView(editor: editor, blockID: id) }
    }

    private var menuTargets: [RecordID] {
        editor.selectedBlocks.contains(id) ? store.documentOrder(Array(editor.selectedBlocks)) : [id]
    }

    private var linkBinding: Binding<Bool> {
        Binding(get: { editor.linkEditor == id }, set: { if !$0, editor.linkEditor == id { editor.linkEditor = nil } })
    }

    private func hasFill(_ b: Block) -> Bool {
        if let c = b.props.color, c.isBackground, b.type != .callout { return true }
        return false
    }

    private func background(_ b: Block) -> Color {
        if let c = b.props.color, c.isBackground, b.type != .callout { return Theme.color(c) }
        return Color.clear
    }

    // MARK: Handle (⋮⋮) — iOS (macOS: page-level gutter in BlockGutter.swift)

    #if os(iOS)
    @ViewBuilder
    private func handle(_ b: Block) -> some View {
        if editor.focusedID == id || editor.selectedBlocks.contains(id) {
            Image(systemName: "circle.grid.2x3.fill")
                .font(.system(size: 9))
                .foregroundStyle(Theme.secondary)
                .frame(width: 14, height: 22)
                .contentShape(Rectangle())
                .onTapGesture { showMenu = true }
                .onDrag {
                    model.draggedBlocks = menuTargets
                    return NSItemProvider(object: id as NSString)
                }
                .offset(x: -16, y: handleOffset(b))
                .popover(isPresented: $showMenu) {
                    BlockMenuView(ids: menuTargets, editor: editor) { showMenu = false }
                        .presentationCompactAdaptation(.popover)
                }
        }
    }

    private func handleOffset(_ b: Block) -> CGFloat {
        let line = Theme.lineHeight(for: b.type, format: editor.format)
        return max(0, (line - 22) / 2) + (b.type.isHeading ? 6 : 0) + (b.type == .heading1 ? 10 : 0)
    }

    // MARK: Drop indicator

    private var dropAlignment: Alignment {
        switch dropEdge {
        case .top?: return .top
        case .left?: return .leading
        case .right?: return .trailing
        default: return .bottom
        }
    }

    @ViewBuilder
    private var dropIndicator: some View {
        if let e = dropEdge {
            if e == .left || e == .right {
                Rectangle().fill(Theme.dropIndicator).frame(width: 3)
            } else {
                Rectangle().fill(Theme.dropIndicator).frame(height: 3)
            }
        }
    }
#endif
}

#if os(iOS)
/// Mutable size holder that SwiftUI doesn't observe (see `BlockRow.geometry`).
final class SizeBox {
    var size = CGSize(width: 600, height: 30)
}

struct BlockDropDelegate: DropDelegate {
    let target: Block
    let model: AppModel
    let editor: EditorController
    let box: SizeBox
    @Binding var edge: DropEdge?

    private var size: CGSize { box.size }

    private func edge(at p: CGPoint) -> DropEdge {
        if p.x > size.width - 48, target.type != .column, target.parent != .workspace { return .right }
        if p.x < 24, target.type != .column { return .left }
        return p.y < min(size.height / 2, 18) ? .top : .bottom
    }

    private var draggable: [RecordID] {
        model.draggedBlocks.filter { $0 != target.id && !model.store.isDescendant(target.id, of: $0) }
    }

    func validateDrop(info: DropInfo) -> Bool { !draggable.isEmpty && !editor.isLocked }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        edge = edge(at: info.location)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) { edge = nil }

    func performDrop(info: DropInfo) -> Bool {
        let e = edge(at: info.location)
        edge = nil
        let ids = draggable
        model.draggedBlocks = []
        guard !ids.isEmpty else { return false }
        let store = model.store
        switch e {
        case .top: store.moveBlocks(ids, to: target.parent, at: .before(target.id))
        case .bottom:
            if store.showsChildrenInline(target), target.type == .toggle, target.props.isOpen == true {
                store.moveBlocks(ids, to: .block(target.id), at: .start)
            } else {
                store.moveBlocks(ids, to: target.parent, at: .after(target.id))
            }
        case .left: store.placeInColumn(ids, beside: target.id, leading: true)
        case .right: store.placeInColumn(ids, beside: target.id, leading: false)
        }
        editor.selectedBlocks = Set(ids)
        return true
    }
}
#endif

// MARK: - Markers (bullets, numbers, checkboxes, toggles)

struct BlockMarker: View {
    let block: Block
    let editor: EditorController
    var number: Int?
    var depth = 0
    @Environment(AppModel.self) private var model

    var body: some View {
        let line = Theme.lineHeight(for: block.type, format: editor.format)
        switch block.type {
        case .bulletedList:
            Text(["•", "◦", "▪"][depth % 3])
                .font(.system(size: Theme.fontSize(for: .text, small: editor.format?.smallText == true) * 1.2))
                .frame(width: 22, height: line)
        case .numberedList:
            Text(Self.label(number ?? 1, depth: depth) + ".")
                .font(.system(size: Theme.fontSize(for: .text, small: editor.format?.smallText == true)))
                .monospacedDigit()
                .frame(minWidth: 22, minHeight: line, alignment: .trailing)
        case .todo:
            let checked = block.props.checked == true
            Button {
                model.store.setChecked(block.id, !checked)
            } label: {
                TodoCheckbox(checked: checked)
            }
            .buttonStyle(.hoverFill)
            .frame(width: 22, height: line)
            .disabled(editor.isLocked)
        case .toggle:
            toggleButton(line: line)
        case .heading1, .heading2, .heading3, .heading4:
            if block.props.toggleable == true { toggleButton(line: line) }
        default:
            EmptyView()
        }
    }

    private func toggleButton(line: CGFloat) -> some View {
        let open = block.props.isOpen == true
        let empty = model.store.contentBlocks(of: block.id).isEmpty
        return Button {
            // The arrow turns and the children fold in/out with one spring (Notion animates both).
            withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) { model.store.toggleOpen(block.id) }
        } label: {
            Image(systemName: "arrowtriangle.right.fill")
                .font(.system(size: 10))
                .rotationEffect(.degrees(open ? 90 : 0))
                .foregroundStyle(empty ? Theme.secondary.opacity(0.5) : Theme.secondary)
                .frame(width: 22, height: line)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(ChromeHoverButtonStyleSmall())
    }

    /// 1. / a. / i. depending on nesting, like Notion.
    static func label(_ n: Int, depth: Int) -> String {
        switch depth % 3 {
        case 1:
            var s = "", x = n
            while x > 0 { x -= 1; s = String(UnicodeScalar(UInt8(97 + x % 26))) + s; x /= 26 }
            return s
        case 2: return roman(n)
        default: return String(n)
        }
    }

    static func roman(_ n: Int) -> String {
        let table: [(Int, String)] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"),
                                      (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
        var x = n, s = ""
        for (v, r) in table { while x >= v { s += r; x -= v } }
        return s
    }
}

// MARK: - Content

struct BlockContent: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        switch block.type {
        case .text, .heading1, .heading2, .heading3, .heading4, .bulletedList, .numberedList, .todo, .toggle:
            BlockText(block: block, editor: editor)
        case .quote:
            HStack(alignment: .top, spacing: 0) {
                Rectangle().fill(Theme.primary).frame(width: 3)
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    BlockText(block: block, editor: editor)
                    ChildBlocks(id: block.id, editor: editor)
                }
                .padding(.leading, 14)
            }
            .padding(.vertical, 2)
        case .callout:
            CalloutView(block: block, editor: editor)
        case .code:
            CodeBlockView(block: block, editor: editor)
        case .divider:
            Rectangle().fill(Color(Theme.divider)).frame(height: 1).padding(.vertical, 10)
                .contentShape(Rectangle())
                .onTapGesture { editor.selectedBlocks = [block.id] }
        case .equation:
            EquationBlockView(block: block, editor: editor)
        case .image, .video, .audio, .file, .pdf, .bookmark, .embed:
            MediaBlockView(block: block, editor: editor)
        case .tableOfContents:
            TableOfContentsView(pageID: editor.pageID, editor: editor)
        case .breadcrumb:
            BreadcrumbView(pageID: editor.pageID)
        case .columnList:
            ColumnsView(block: block, editor: editor)
        case .column:
            ChildBlocks(id: block.id, editor: editor)
        case .table:
            SimpleTableView(block: block, editor: editor)
        case .tableRow:
            EmptyView()
        case .databaseInline:
            DatabaseBlockView(blockID: block.id, fullPage: false)
        case .databasePage, .page:
            PageLinkView(pageID: block.id, editor: editor)
        case .linkToPage:
            PageLinkView(pageID: block.props.linkTarget ?? "", editor: editor, isLink: true)
        case .syncedBlock:
            SyncedBlockView(block: block, editor: editor)
        case .button:
            ButtonBlockView(block: block, editor: editor)
        }
    }
}

struct ChildBlocks: View {
    let id: RecordID
    let editor: EditorController
    @Environment(AppModel.self) private var model
    var body: some View {
        if !model.registry.block(id).children.isEmpty {
            BlockList(parentID: id, editor: editor)
        }
    }
}

/// The editable rich text of a block.
struct BlockText: View {
    let block: Block
    let editor: EditorController

    var body: some View {
        RichTextView(id: block.id, text: block.text, config: config, controller: editor)
    }

    var config: RichTextConfig {
        let style = TextStyle(type: block.type, format: editor.format,
                              color: block.props.color.flatMap { $0.isBackground ? nil : $0 },
                              checked: block.type == .todo && block.props.checked == true)
        var st = style
        if block.type == .code { st.language = block.props.language }
        var c = RichTextConfig(style: st)
        c.placeholder = block.type.placeholder
        c.alwaysShowPlaceholder = block.type.isHeading
        c.plain = block.type == .code
        c.editable = !editor.isLocked
        return c
    }
}

struct CalloutView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var pickingIcon = false

    var body: some View {
        let bg = block.props.color.map { $0.isBackground ? $0 : $0.background } ?? .grayBackground
        HStack(alignment: .top, spacing: 8) {
            Button { pickingIcon = true } label: {
                PageIconView(icon: block.props.icon ?? .emoji("💡"), size: 22)
                    .frame(height: Theme.lineHeight(for: .text, format: editor.format))
            }
            .buttonStyle(.hoverFill)
            .popover(isPresented: $pickingIcon) {
                IconPicker(current: block.props.icon) { icon in
                    model.store.updateBlock(block.id, name: "Callout icon") { $0.props.icon = icon ?? .emoji("💡") }
                    pickingIcon = false
                }
            }
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                BlockText(block: block, editor: editor)
                ChildBlocks(id: block.id, editor: editor)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.color(bg)))
    }
}

struct CodeBlockView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    static let languages = ["plain text", "bash", "c", "c++", "c#", "css", "dart", "diff", "docker", "elixir", "go", "graphql",
                            "haskell", "html", "java", "javascript", "json", "kotlin", "latex", "lua", "makefile", "markdown",
                            "mermaid", "objective-c", "perl", "php", "powershell", "python", "r", "ruby", "rust", "scala",
                            "shell", "sql", "swift", "toml", "typescript", "xml", "yaml"]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Menu(block.props.language ?? "plain text") {
                    ForEach(Self.languages, id: \.self) { lang in
                        Button(lang) { model.store.updateBlock(block.id, name: "Language") { $0.props.language = lang } }
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .font(.system(size: 12))
                if CodePreviewToggle.supports(block.props.language) { CodePreviewToggle(block: block) }
                Spacer()
                if hovering {
                    Button(block.props.wrap == false ? "Wrap" : "No wrap") {
                        model.store.updateBlock(block.id, name: "Wrap code") { $0.props.wrap = !($0.props.wrap ?? true) }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                    Button("Copy") { Clipboard.copy(block.text.plainText) }
                        .buttonStyle(.plain)
                        .font(.system(size: 12))
                }
            }
            .foregroundStyle(Theme.secondary)
            if CodePreviewToggle.supports(block.props.language), CodePreviewToggle.isPreview(block) {
                HTMLPreview(source: block.text.plainText, language: block.props.language ?? "html", height: previewHeight(from: block.props.caption) ?? 320)
            } else {
                BlockText(block: block, editor: editor)
            }
            if let cap = block.props.caption, !cap.isEmpty, !cap.plainText.hasPrefix("height=") {
                Text(cap.plainText).font(.system(size: 13)).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 4).fill(Color(Theme.codeBackground)))
        .onHover { hovering = $0 }
    }
}

struct ColumnsView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    /// Live fractions while a divider is dragged; written to the store when the drag ends.
    @State private var draft: [Double]?

    var body: some View {
        let cols = model.registry.block(block.id).children
        let stored = cols.map { model.store.blocks[$0]?.props.ratio ?? 0 }
        let ratios = draft ?? stored
        let spacing = BlockRow.gutter + 2
        ColumnsLayout(ratios: ratios, spacing: spacing) {
            ForEach(cols, id: \.self) { cid in
                // Wide content (a scrolled board, a table) stays inside its column instead of drawing over the next.
                ColumnView(id: cid, editor: editor)
                    .clipShape(Rectangle().inset(by: -6))
            }
        }
        .overlay {
            if !editor.isLocked, cols.count > 1 {
                GeometryReader { geo in
                    let fr = ColumnsLayout.fractions(ratios, count: cols.count)
                    let avail = max(1, geo.size.width - spacing * CGFloat(cols.count - 1))
                    ForEach(0..<(cols.count - 1), id: \.self) { i in
                        let x = fr[...i].reduce(0, +) * avail + spacing * CGFloat(i) + spacing / 2
                        ResizeHandle(hitWidth: 12,
                                     onBegan: {},
                                     onChanged: { dx in
                                         var f = fr
                                         let base = ColumnsLayout.fractions(stored, count: cols.count)
                                         let d = Double(dx / avail)
                                         let pair = base[i] + base[i + 1]
                                         let left = min(max(0.1, base[i] + d), pair - 0.1)
                                         f[i] = left; f[i + 1] = pair - left
                                         draft = f
                                     },
                                     onEnded: {
                                         if let f = draft { model.store.setColumnRatios(cols, f) }
                                         draft = nil
                                     })
                            .frame(height: geo.size.height)
                            .position(x: x, y: geo.size.height / 2)
                    }
                }
            }
        }
    }
}

/// Lays out columns side by side with widths proportional to their ratios.
/// Measuring a column means measuring everything in it (whole databases, boards, calendars), and SwiftUI asks
/// for the size several times per pass, so heights are cached per width until the subviews change.
struct ColumnsLayout: Layout {
    var ratios: [Double]
    var spacing: CGFloat

    /// Ratios may be stored as fractions or percentages, and new columns have none: missing ones take the
    /// average share, and no column drops below 5% of the row. Result sums to 1.
    static func fractions(_ ratios: [Double], count: Int) -> [Double] {
        let given = (0..<count).map { $0 < ratios.count && ratios[$0] > 0 ? ratios[$0] : nil }
        let known = given.compactMap { $0 }
        let fill = known.isEmpty ? 1 : known.reduce(0, +) / Double(known.count)
        let raw = given.map { $0 ?? fill }
        let rawSum = raw.reduce(0, +)
        let r = raw.map { max(0.05, $0 / rawSum) }
        let sum = r.reduce(0, +)
        return r.map { $0 / sum }
    }

    private func widths(_ total: CGFloat, count: Int) -> [CGFloat] {
        let r = Self.fractions(ratios, count: count)
        let sum = r.reduce(0, +)
        let avail = max(0, total - spacing * CGFloat(max(0, count - 1)))
        return r.map { avail * CGFloat($0 / sum) }
    }

    // No height cache here: a cached height went stale when content inside a column changed
    // (a moved block, an opened toggle) and the columns drew over each other.
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let total = proposal.width ?? 600
        let w = widths(total, count: subviews.count)
        var h: CGFloat = 0
        for (i, sv) in subviews.enumerated() {
            h = max(h, sv.sizeThatFits(ProposedViewSize(width: w[i], height: nil)).height)
        }
        return CGSize(width: total, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let w = widths(bounds.width, count: subviews.count)
        var x = bounds.minX
        for (i, sv) in subviews.enumerated() {
            sv.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(width: w[i], height: nil))
            x += w[i] + spacing
        }
    }
}

struct ColumnView: View {
    let id: RecordID
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BlockList(parentID: id, editor: editor)
            Color.clear.frame(height: 8).contentShape(Rectangle())
                .onTapGesture {
                    let kids = model.store.contentBlocks(of: id)
                    if let last = kids.last, last.type.isTextEditable { editor.focusEnd(last.id) }
                    else { editor.focus(FocusTarget(model.store.insertBlock(.text, in: .block(id)), 0)) }
                }
        }
    }
}

/// A sub-page, full-page database or "link to page" block.
struct PageLinkView: View {
    let pageID: RecordID
    let editor: EditorController
    var isLink = false
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    var body: some View {
        let node = model.registry.block(pageID)
        let _ = model.registry.workspace.structureRevision
        Button {
            model.open(pageID)
        } label: {
            HStack(spacing: 6) {
                PageIconView(icon: node.block?.props.icon, isDatabase: node.block?.type == .databasePage, size: 20)
                if isLink { Image(systemName: "arrow.turn.up.right").font(.system(size: 10)).foregroundStyle(Theme.secondary) }
                Text(node.block == nil ? "Page not found" : model.store.title(of: pageID).isEmpty ? "Untitled" : model.store.title(of: pageID))
                    .font(.system(size: Theme.fontSize(for: .text, small: editor.format?.smallText == true), weight: .medium))
                    .underline(true, color: Color(Theme.divider))
                    .foregroundStyle(Theme.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 3)
            .padding(.horizontal, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(hovering ? Color(Theme.codeBackground) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

struct SyncedBlockView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    var body: some View {
        let source = block.props.syncSource ?? block.id
        let isCopy = block.props.syncSource != nil
        VStack(alignment: .leading, spacing: 4) {
            if hovering {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 11))
                    Text(isCopy ? "Editing in \(model.store.containingPage(of: source).map { model.store.title(of: $0) } ?? "another page")" : "Original synced block")
                        .font(.system(size: 12))
                    Spacer()
                    Button(isCopy ? "Unsync" : "Copy and sync") {
                        if isCopy { unsync(source) } else { Clipboard.copy("based-sync:" + block.id) }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                }
                .foregroundStyle(Color.orange)
            }
            if model.store.blocks[source] == nil {
                Text("The original synced block was deleted.").foregroundStyle(Theme.secondary)
            } else {
                BlockList(parentID: source, editor: editor)
            }
        }
        .padding(6)
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(hovering ? Color.orange.opacity(0.8) : Color.clear, lineWidth: 2))
        .onHover { hovering = $0 }
    }

    /// Turn a synced copy into independent blocks.
    private func unsync(_ source: RecordID) {
        let store = model.store
        store.transact("Unsync") { tx in
            let kids = store.contentBlocks(of: source)
            let keys = FractionalIndex.keys(count: kids.count, between: nil, nil)
            for (k, key) in zip(kids, keys) { _ = store.copySubtree(k, parent: .block(block.id), sortKey: key, tx: tx) }
            tx.update(block.id) { $0.props.syncSource = nil }
        }
    }
}

/// Notion button: inserts its (hidden) child blocks, adds a page to a database, or opens a page.
struct ButtonBlockView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var editing = false
    @State private var label = ""
    @State private var hover = false
    @State private var pageQuery = ""

    private var action: ButtonAction { block.props.buttonAction ?? ButtonAction(kind: .insertBlocks) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Button { run() } label: {
                    Label(block.props.buttonLabel ?? "New button", systemImage: symbol)
                        .font(.system(size: 14, weight: .medium))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.hoverFill))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(Theme.divider), lineWidth: 0.5))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(helpText)
                Button { editing.toggle(); label = block.props.buttonLabel ?? "" } label: {
                    Image(systemName: "gearshape").font(.system(size: 12))
                }
                .buttonStyle(.hoverFill)
                .foregroundStyle(Theme.secondary)
                .opacity(hover || editing ? 1 : 0)
                .help("Edit button")
            }
            .onHover { hover = $0 }
            if editing { config }
        }
    }

    private var symbol: String {
        switch action.kind {
        case .insertBlocks: return "plus.square.on.square"
        case .addPage: return "plus"
        case .openPage: return "arrow.up.right"
        }
    }

    private var helpText: String {
        switch action.kind {
        case .insertBlocks: return "Insert blocks"
        case .addPage: return "Add a page to " + (action.targetID.flatMap { model.store.databases[$0]?.title.plainText } ?? "a database")
        case .openPage: return "Open " + (action.targetID.map { model.store.title(of: $0) } ?? "a page")
        }
    }

    private func setAction(_ f: (inout ButtonAction) -> Void) {
        var a = action
        f(&a)
        model.store.updateBlock(block.id, name: "Edit button") { $0.props.buttonAction = a }
    }

    @ViewBuilder
    private var config: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Button name", text: $label)
                .textFieldStyle(.roundedBorder)
                .onSubmit { model.store.updateBlock(block.id, name: "Rename button") { $0.props.buttonLabel = label } }
                .onChange(of: label) { _, v in model.store.updateBlock(block.id, name: "Rename button") { $0.props.buttonLabel = v } }
            Picker("When clicked", selection: Binding(get: { action.kind }, set: { k in setAction { $0.kind = k; $0.targetID = nil } })) {
                Text("Insert blocks").tag(ButtonAction.Kind.insertBlocks)
                Text("Add page to database").tag(ButtonAction.Kind.addPage)
                Text("Open page").tag(ButtonAction.Kind.openPage)
            }
            .pickerStyle(.menu)
            .fixedSize()
            switch action.kind {
            case .insertBlocks:
                Text("Blocks to insert when clicked:").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                if model.registry.block(block.id).children.isEmpty {
                    Button("Add a block") { editor.focus(FocusTarget(model.store.insertBlock(.todo, in: .block(block.id)), 0)) }
                        .buttonStyle(.hoverFill).foregroundStyle(Theme.secondary)
                }
                BlockList(parentID: block.id, editor: editor)
            case .addPage:
                let dbs = model.store.databases.values.filter { model.store.blocks[$0.blockID]?.trashedAt == nil }
                    .sorted { $0.title.plainText.localizedCaseInsensitiveCompare($1.title.plainText) == .orderedAscending }
                Picker("Database", selection: Binding(get: { action.targetID ?? "" }, set: { id in setAction { $0.targetID = id.isEmpty ? nil : id } })) {
                    Text("Choose…").tag("")
                    ForEach(dbs, id: \.id) { db in Text(db.title.plainText.isEmpty ? "Untitled" : db.title.plainText).tag(db.id) }
                }
                .pickerStyle(.menu)
                .fixedSize()
                Toggle("Open the new page", isOn: Binding(get: { action.openAfter ?? true }, set: { v in setAction { $0.openAfter = v } }))
                    .toggleStyle(.checkbox)
            case .openPage:
                HStack(spacing: 6) {
                    if let t = action.targetID { Text(model.store.title(of: t)).fontWeight(.medium) }
                    TextField("Search pages…", text: $pageQuery).textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                }
                if !pageQuery.isEmpty {
                    let q = pageQuery.lowercased()
                    ForEach(model.store.allPages().filter { $0.trashedAt == nil && $0.title.lowercased().contains(q) }.prefix(8), id: \.id) { p in
                        Button { setAction { $0.targetID = p.id }; pageQuery = "" } label: {
                            HStack(spacing: 6) {
                                PageIconView(icon: p.props.icon, size: 14)
                                Text(model.store.title(of: p.id)).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.hoverFill)
                    }
                }
            }
        }
        .font(.system(size: 13))
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).stroke(Color(Theme.divider)))
    }

    private func run() {
        switch action.kind {
        case .addPage:
            guard let dbID = action.targetID, model.store.databases[dbID] != nil else { editing = true; return }
            let id = model.store.addRow(to: dbID)
            if action.openAfter ?? true { model.open(id, mode: .centerPeek) }
            return
        case .openPage:
            guard let id = action.targetID, model.store.blocks[id] != nil else { editing = true; return }
            model.open(id)
            return
        case .insertBlocks: break
        }
        let store = model.store
        let kids = store.contentBlocks(of: block.id)
        guard !kids.isEmpty else { editing = true; return }
        var last = block.id
        store.transact("Insert from button") { tx in
            let keys = tx.sortKeys(kids.count, in: block.parent, .after(block.id))
            for (k, key) in zip(kids, keys) { last = store.copySubtree(k, parent: block.parent, sortKey: key, tx: tx) }
        }
        editor.focusEnd(last)
    }
}

struct TableOfContentsView: View {
    let pageID: RecordID
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        let _ = model.registry.workspace.revision
        let headings = model.store.visibleOrder(in: pageID).compactMap { model.store.blocks[$0] }.filter { $0.type.isHeading }
        VStack(alignment: .leading, spacing: 2) {
            if headings.isEmpty {
                Text("Add headings to create a table of contents.").foregroundStyle(Theme.secondary).font(.system(size: 14))
            }
            ForEach(headings) { h in
                Button { editor.focus(FocusTarget(h.id, 0)) } label: {
                    Text(h.text.plainText.isEmpty ? "Untitled" : h.text.plainText)
                        .font(.system(size: 14))
                        .underline(true, color: Color(Theme.divider))
                        .foregroundStyle(Theme.secondary)
                        .padding(.leading, CGFloat(indent(h.type)) * 16)
                }
                .buttonStyle(.hoverFill)
            }
        }
        .padding(.vertical, 4)
    }

    private func indent(_ t: BlockType) -> Int {
        switch t { case .heading2: return 1; case .heading3: return 2; case .heading4: return 3; default: return 0 }
    }
}

struct BreadcrumbView: View {
    let pageID: RecordID
    @Environment(AppModel.self) private var model

    var body: some View {
        let _ = model.registry.workspace.structureRevision
        let full = model.store.ancestors(of: pageID).filter { $0.type.isPageLike }.reversed() + [model.store.blocks[pageID]].compactMap { $0 }
        let chain = Array(full.suffix(3))   // long paths would push the peek buttons out of the header
        HStack(spacing: 4) {
            if full.count > chain.count { Text("… /").foregroundStyle(Theme.secondary) }
            ForEach(Array(chain.enumerated()), id: \.offset) { i, b in
                if i > 0 { Text("/").foregroundStyle(Theme.secondary) }
                Button { model.open(b.id) } label: {
                    HStack(spacing: 3) {
                        PageIconView(icon: b.props.icon, isDatabase: b.type == .databasePage, size: 14)
                        Text(b.title.isEmpty ? "Untitled" : b.title).lineLimit(1).truncationMode(.middle)
                    }
                }
                .buttonStyle(.hoverFill)
            }
        }
        .font(.system(size: 13))
        .foregroundStyle(Theme.secondary)
    }
}

enum Clipboard {
    /// Copies page links: plain text `based://page/<id>` (what agents and other apps use), plus a titled rich link
    /// (HTML) and a URL so mail, Slack and editors paste a clickable "Title".
    @MainActor static func copyLinks(_ ids: [RecordID], store: WorkspaceStore) {
        let urls = ids.map(PageLink.url)
        #if os(macOS)
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(urls.joined(separator: "\n"), forType: .string)
        let html = ids.map { id in
            let t = store.title(of: id).isEmpty ? "Untitled" : store.title(of: id)
            let esc = t.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            return "<a href=\"\(PageLink.url(id))\">\(esc)</a>"
        }.joined(separator: "<br>")
        pb.setString(html, forType: .html)
        if urls.count == 1 { pb.setString(urls[0], forType: .URL) }
        #else
        UIPasteboard.general.string = urls.joined(separator: "\n")
        #endif
    }

    static func copy(_ s: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #else
        UIPasteboard.general.string = s
        #endif
    }

    static var string: String? {
        #if os(macOS)
        return NSPasteboard.general.string(forType: .string)
        #else
        return UIPasteboard.general.string
        #endif
    }
}

/// Notion's to-do box: thin grey outline; checked = blue fill with a white check, popping in with a spring.
struct TodoCheckbox: View {
    let checked: Bool
    @State private var hover = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 3.5)
                .fill(checked ? Theme.todoBlue : (hover ? Theme.hoverFill : Color.clear))
            RoundedRectangle(cornerRadius: 3.5)
                .strokeBorder(checked ? Color.clear : Theme.secondary.opacity(0.8), lineWidth: 1.4)
            Image(systemName: "checkmark")
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(.white)
                .scaleEffect(checked ? 1 : 0.3)
                .opacity(checked ? 1 : 0)
        }
        .frame(width: 16, height: 16)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .animation(.spring(response: 0.22, dampingFraction: 0.62), value: checked)
    }
}


/// Small hover fill for inline controls (toggle arrow).
struct ChromeHoverButtonStyleSmall: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { HoverBody(configuration: configuration) }
    private struct HoverBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hover = false
        var body: some View {
            configuration.label
                .background(RoundedRectangle(cornerRadius: 4).fill(hover ? Theme.hoverFill : .clear).padding(2))
                .opacity(configuration.isPressed ? 0.7 : 1)
                .onHover { hover = $0 }
        }
    }
}
