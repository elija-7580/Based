import SwiftUI
import BasedCore

/// Notion's "simple table" block: a grid of text cells with optional header row / column.
/// Like Notion: cells fill their row (no uneven inner borders), columns are resizable by dragging their right edge,
/// rows and columns have hover handles (insert left / right / above / below, colour, header, delete), cells and
/// rows / columns can be highlighted, and + buttons on the right and bottom edge add a column / row.
struct SimpleTableView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var hoverBottom = false
    @State private var hoverRight = false
    @State private var hoverCell: (r: Int, c: Int)? = nil
    @State private var dragWidths: [CGFloat]? = nil

    static let defaultWidth: CGFloat = 160
    private var store: WorkspaceStore { model.store }
    private var columns: Int { max(1, block.props.tableColumns ?? 1) }
    private var locked: Bool { editor.isLocked }

    private var widths: [CGFloat] {
        if let d = dragWidths, d.count == columns { return d }
        let stored = block.props.tableColumnWidths ?? []
        return (0..<columns).map { $0 < stored.count && stored[$0] > 0 ? CGFloat(stored[$0]) : Self.defaultWidth }
    }

    var body: some View {
        let node = model.registry.block(block.id)
        let rows = node.children.compactMap { model.registry.block($0).block }.filter { $0.type == .tableRow }
        let w = widths
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 2) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { r, row in
                            GridRow {
                                ForEach(0..<columns, id: \.self) { c in
                                    cell(row: row, r: r, c: c, rows: rows, width: w[c])
                                }
                            }
                        }
                    }
                    .overlay(Rectangle().stroke(Color(Theme.divider), lineWidth: 1))
                    // Each row as tall as its tallest cell: without this the page's height proposal was shared out
                    // evenly, so all rows got the same height and long cells were cut off.
                    .fixedSize(horizontal: false, vertical: true)
                    // Room for the row / column handles that sit just outside the grid.
                    .padding(.top, DS.Space.lg).padding(.leading, 14).padding(.bottom, 1).padding(.trailing, 1)
                }
                .padding(.top, -12).padding(.leading, -14)
                if !locked {
                    addButton(vertical: true) { addColumn(at: columns) }
                        .opacity(hoverRight ? 1 : 0.001)
                        .onHover { hoverRight = $0 }
                        .help("Add a column")
                }
            }
            if !locked {
                addButton(vertical: false) { addRow(after: rows.last?.id) }
                    .opacity(hoverBottom ? 1 : 0.001)
                    .onHover { hoverBottom = $0 }
                    .padding(.top, DS.Space.xxs)
                    .help("Add a row")
            }
        }
        .onKeyPress(.escape) { selectTable(); return .handled }
    }

    private func addButton(vertical: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "plus").font(DS.Text.caption(.medium)).foregroundStyle(Theme.secondary)
                .frame(maxWidth: vertical ? 18 : .infinity, maxHeight: vertical ? .infinity : 18)
                .frame(width: vertical ? 18 : nil, height: vertical ? nil : 18)
                .background(RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous).fill(Theme.hoverFill))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickableCursor()
    }

    private func fill(row: Block, c: Int) -> Color {
        if let cc = row.props.cellColors, cc.indices.contains(c), let t = cc[c] { return Theme.color(t) }
        if let t = row.props.color, t.isBackground { return Theme.color(t) }
        if let cols = block.props.tableColumnColors, cols.indices.contains(c), let t = cols[c] { return Theme.color(t) }
        return .clear
    }

    @ViewBuilder
    private func cell(row: Block, r: Int, c: Int, rows: [Block], width: CGFloat) -> some View {
        let header = (block.props.tableHeaderRow == true && r == 0) || (block.props.tableHeaderColumn == true && c == 0)
        let text = (row.props.cells ?? []).indices.contains(c) ? row.props.cells![c] : RichText()
        let hovered = hoverCell.map { $0.r == r && $0.c == c } ?? false
        TableCellField(text: text, bold: header, editable: !locked, width: width,
                       onFocus: { editor.selectedBlocks = [] }, onEscape: { selectTable() }) { new in
            store.updateBlock(row.id, name: "Edit cell", coalesce: "cell-\(row.id)-\(c)") { b in
                var cells = b.props.cells ?? []
                while cells.count <= c { cells.append(RichText()) }
                cells[c] = new
                b.props.cells = cells
            }
        }
        // Fill the whole row height, so every cell of a row shares one border.
        .frame(width: width, alignment: .topLeading)
        .frame(minHeight: 34, maxHeight: .infinity, alignment: .topLeading)
        .background(fill(row: row, c: c))
        .background(header ? Color.primary.opacity(0.04) : Color.clear)
        .overlay(Rectangle().stroke(Color(Theme.divider), lineWidth: 0.5))
        .overlay(alignment: .trailing) {
            if !locked { columnResizer(c) }
        }
        .overlay(alignment: .top) {
            if !locked, r == 0, hoverCell?.c == c { columnHandle(c).offset(y: -11) }
        }
        .overlay(alignment: .leading) {
            if !locked, c == 0, hoverCell?.r == r { rowHandle(row, r: r, rows: rows).offset(x: -13) }
        }
        .onHover { h in
            if h { hoverCell = (r, c) } else if hovered { hoverCell = nil }
        }
        .contextMenu { if !locked { cellMenu(row: row, r: r, c: c, rows: rows) } }
    }

    // MARK: Handles

    private func handleLabel(horizontal: Bool) -> some View {
        Image(systemName: "ellipsis")
            .font(.system(size: 9, weight: .bold))
            .rotationEffect(.degrees(horizontal ? 0 : 90))
            .foregroundStyle(Theme.secondary)
            .frame(width: horizontal ? 22 : 12, height: horizontal ? 12 : 22)
            .background(RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous).fill(Chrome.appBackground))
            .overlay(RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous).stroke(Color(Theme.divider)))
            .contentShape(Rectangle())
    }

    private func columnHandle(_ c: Int) -> some View {
        Menu {
            Button("Insert left", systemImage: "arrow.left.to.line") { addColumn(at: c) }
            Button("Insert right", systemImage: "arrow.right.to.line") { addColumn(at: c + 1) }
            colorMenu("Column color") { setColumnColor(c, $0) }
            if c == 0 {
                Button(block.props.tableHeaderColumn == true ? "Remove header column" : "Header column", systemImage: "tablecells") { toggleHeaderColumn() }
            }
            Button("Reset width", systemImage: "arrow.left.and.right") { setWidth(c, nil) }
            Divider()
            Button("Delete column", systemImage: "trash", role: .destructive) { deleteColumn(c) }
        } label: { handleLabel(horizontal: true) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("Column options")
    }

    private func rowHandle(_ row: Block, r: Int, rows: [Block]) -> some View {
        Menu {
            Button("Insert above", systemImage: "arrow.up.to.line") { addRow(before: row.id) }
            Button("Insert below", systemImage: "arrow.down.to.line") { addRow(after: row.id) }
            colorMenu("Row color") { color in store.updateBlock(row.id, name: "Row color") { $0.props.color = color } }
            if r == 0 {
                Button(block.props.tableHeaderRow == true ? "Remove header row" : "Header row", systemImage: "tablecells") { toggleHeaderRow() }
            }
            Divider()
            Button("Delete row", systemImage: "trash", role: .destructive) { if rows.count > 1 { store.deleteBlocks([row.id]) } }
        } label: { handleLabel(horizontal: false) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("Row options")
    }

    @ViewBuilder
    private func cellMenu(row: Block, r: Int, c: Int, rows: [Block]) -> some View {
        colorMenu("Cell color") { color in
            store.updateBlock(row.id, name: "Cell color") { b in
                var cc = b.props.cellColors ?? []
                while cc.count <= c { cc.append(nil) }
                cc[c] = color
                b.props.cellColors = cc.allSatisfy { $0 == nil } ? nil : cc
            }
        }
        colorMenu("Row color") { color in store.updateBlock(row.id, name: "Row color") { $0.props.color = color } }
        colorMenu("Column color") { setColumnColor(c, $0) }
        Divider()
        Button("Insert row above") { addRow(before: row.id) }
        Button("Insert row below") { addRow(after: row.id) }
        Button("Insert column left") { addColumn(at: c) }
        Button("Insert column right") { addColumn(at: c + 1) }
        Divider()
        Button(block.props.tableHeaderRow == true ? "Remove header row" : "Header row") { toggleHeaderRow() }
        Button(block.props.tableHeaderColumn == true ? "Remove header column" : "Header column") { toggleHeaderColumn() }
        Divider()
        Button("Clear cell") {
            store.updateBlock(row.id, name: "Clear cell") { b in
                if var cells = b.props.cells, cells.indices.contains(c) { cells[c] = RichText(); b.props.cells = cells }
            }
        }
        Button("Delete row", role: .destructive) { if rows.count > 1 { store.deleteBlocks([row.id]) } }
        Button("Delete column", role: .destructive) { deleteColumn(c) }
        Divider()
        Button("Select table") { selectTable() }
    }

    private func colorMenu(_ title: String, _ apply: @escaping (TColor?) -> Void) -> some View {
        Menu(title) {
            Button("Default") { apply(nil) }
            ForEach(TColor.allCases.filter(\.isBackground), id: \.self) { t in
                Button(t.rawValue.replacingOccurrences(of: "Background", with: "").capitalized) { apply(t) }
            }
        }
    }

    // MARK: Column widths

    private func columnResizer(_ c: Int) -> some View {
        ResizeHandle(hitWidth: 8,
                     onBegan: { dragWidths = widths },
                     onChanged: { dx in
                         var w = widths
                         let base = (block.props.tableColumnWidths ?? []).indices.contains(c) && block.props.tableColumnWidths![c] > 0
                             ? CGFloat(block.props.tableColumnWidths![c]) : Self.defaultWidth
                         w[c] = max(60, base + dx)
                         dragWidths = w
                     },
                     onEnded: {
                         if let d = dragWidths { store.updateBlock(block.id, name: "Resize column") { $0.props.tableColumnWidths = d.map(Double.init) } }
                         dragWidths = nil
                     },
                     onDoubleClick: { setWidth(c, nil) })
            .offset(x: 4)
    }

    private func setWidth(_ c: Int, _ w: CGFloat?) {
        store.updateBlock(block.id, name: "Resize column") { b in
            var ws = b.props.tableColumnWidths ?? []
            while ws.count < columns { ws.append(0) }
            ws[c] = w.map(Double.init) ?? 0
            b.props.tableColumnWidths = ws.allSatisfy { $0 == 0 } ? nil : ws
        }
    }

    // MARK: Edits

    private func selectTable() {
        #if os(macOS)
        NSApp.keyWindow?.makeFirstResponder(nil)
        #endif
        editor.selectedBlocks = [block.id]
    }

    private func toggleHeaderRow() {
        store.updateBlock(block.id, name: "Header row") { $0.props.tableHeaderRow = !($0.props.tableHeaderRow == true) }
    }

    private func toggleHeaderColumn() {
        store.updateBlock(block.id, name: "Header column") { $0.props.tableHeaderColumn = !($0.props.tableHeaderColumn == true) }
    }

    private func setColumnColor(_ c: Int, _ color: TColor?) {
        store.updateBlock(block.id, name: "Column color") { b in
            var cc = b.props.tableColumnColors ?? []
            while cc.count < columns { cc.append(nil) }
            cc[c] = color
            b.props.tableColumnColors = cc.allSatisfy { $0 == nil } ? nil : cc
        }
    }

    private func emptyRowProps() -> BlockProps {
        var p = BlockProps()
        p.cells = Array(repeating: RichText(), count: columns)
        return p
    }

    private func addRow(after id: RecordID?) {
        if let id { _ = store.insertBlock(.tableRow, after: id, props: emptyRowProps()) }
        else { _ = store.insertBlock(.tableRow, props: emptyRowProps(), in: .block(block.id)) }
    }

    private func addRow(before id: RecordID) {
        _ = store.insertBlock(.tableRow, props: emptyRowProps(), in: .block(block.id), at: .before(id))
    }

    private func addColumn(at index: Int) {
        let rowIDs = store.children(of: .block(block.id))
        store.transact("Insert column") { tx in
            tx.update(block.id) { b in
                b.props.tableColumns = columns + 1
                if var ws = b.props.tableColumnWidths { while ws.count < columns { ws.append(0) }; ws.insert(0, at: min(index, ws.count)); b.props.tableColumnWidths = ws }
                if var cc = b.props.tableColumnColors { while cc.count < columns { cc.append(nil) }; cc.insert(nil, at: min(index, cc.count)); b.props.tableColumnColors = cc }
            }
            for id in rowIDs {
                tx.update(id) { b in
                    var cells = b.props.cells ?? []
                    while cells.count < columns { cells.append(RichText()) }
                    cells.insert(RichText(), at: min(index, cells.count))
                    b.props.cells = cells
                    if var cc = b.props.cellColors { while cc.count < columns { cc.append(nil) }; cc.insert(nil, at: min(index, cc.count)); b.props.cellColors = cc }
                }
            }
        }
    }

    private func deleteColumn(_ index: Int) {
        guard columns > 1 else { return }
        let rowIDs = store.children(of: .block(block.id))
        store.transact("Delete column") { tx in
            tx.update(block.id) { b in
                b.props.tableColumns = columns - 1
                if var ws = b.props.tableColumnWidths, ws.indices.contains(index) { ws.remove(at: index); b.props.tableColumnWidths = ws }
                if var cc = b.props.tableColumnColors, cc.indices.contains(index) { cc.remove(at: index); b.props.tableColumnColors = cc }
            }
            for id in rowIDs {
                tx.update(id) { b in
                    var cells = b.props.cells ?? []
                    if cells.indices.contains(index) { cells.remove(at: index) }
                    b.props.cells = cells
                    if var cc = b.props.cellColors, cc.indices.contains(index) { cc.remove(at: index); b.props.cellColors = cc }
                }
            }
        }
    }
}

/// Rich-text editor for a table cell: ⌘B / ⌘I / ⌘U / ⇧⌘S / ⌘E format the selection like in any other block.
struct TableCellField: View {
    let text: RichText
    var bold = false
    var editable = true
    var width: CGFloat = SimpleTableView.defaultWidth
    var onFocus: () -> Void = {}
    var onEscape: () -> Void = {}
    let onChange: (RichText) -> Void
    #if !os(macOS)
    @State private var draft = ""
    #endif

    var body: some View {
        Group {
            #if os(macOS)
            if editable {
                TableCellTextView(text: text, header: bold, textWidth: max(20, width - 16), onFocus: onFocus, onEscape: onEscape, onChange: onChange)
                    .frame(width: max(20, width - 16), alignment: .topLeading)
            } else {
                Text(text.plainText)
            }
            #else
            if editable {
                TextField("", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .onChange(of: draft) { _, v in if v != text.plainText { onChange(RichText(v)) } }
            } else {
                Text(text.plainText)
            }
            #endif
        }
        .font(.system(size: 14, weight: bold ? .semibold : .regular))
        .padding(.horizontal, DS.Space.md)
        .padding(.vertical, 7)
        #if !os(macOS)
        .onAppear { draft = text.plainText }
        .onChange(of: text.plainText) { _, v in if v != draft { draft = v } }
        #endif
    }
}

#if os(macOS)
import AppKit

struct TableCellTextView: NSViewRepresentable {
    let text: RichText
    let header: Bool
    var textWidth: CGFloat = 144
    var onFocus: () -> Void = {}
    var onEscape: () -> Void = {}
    let onChange: (RichText) -> Void
    @Environment(AppModel.self) private var model

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TableCellTextView
        var applied = RichText()
        var isApplying = false
        weak var view: BasedNSTextView?
        init(_ p: TableCellTextView) { parent = p }

        private var style: TextStyle { TextStyle(type: .text, format: nil, color: nil) }

        func load(_ rt: RichText, selection: NSRange?) {
            guard let v = view else { return }
            isApplying = true
            let attr = NSMutableAttributedString(attributedString: AttributedBridge.attributed(rt, style: style, store: parent.model.store))
            if parent.header, attr.length > 0 {
                attr.enumerateAttribute(.font, in: NSRange(location: 0, length: attr.length)) { f, r, _ in
                    if let f = f as? NSFont { attr.addAttribute(.font, value: NSFontManager.shared.convert(f, toHaveTrait: .boldFontMask), range: r) }
                }
            }
            v.textStorage?.setAttributedString(attr)
            applied = AttributedBridge.richText(attr)
            if let s = selection {
                let loc = max(0, min(s.location, attr.length))
                v.setSelectedRange(NSRange(location: loc, length: max(0, min(s.length, attr.length - loc))))
            }
            v.typingAttributes = AttributedBridge.typingAttributes(applied.marks(at: v.selectedRange().location), style: style)
            isApplying = false
            v.invalidateIntrinsicContentSize()
        }

        /// Esc (cancelOperation / complete) leaves the cell and selects the table.
        func textView(_ textView: NSTextView, doCommandBy sel: Selector) -> Bool {
            if sel == #selector(NSResponder.cancelOperation(_:)) || sel == #selector(NSTextView.complete(_:)) {
                parent.onEscape(); return true
            }
            return false
        }

        func textDidChange(_ notification: Notification) {
            guard !isApplying, let v = view, let storage = v.textStorage, !v.hasMarkedText() else { return }
            let rt = AttributedBridge.richText(storage)
            applied = rt
            parent.onChange(rt)
            v.invalidateIntrinsicContentSize()
        }

        func toggle(_ kind: MarkKind) {
            guard let v = view else { return }
            let r = v.selectedRange()
            if r.length == 0 {
                var m = applied.marks(at: r.location)
                kind.set(&m, !kind.get(m))
                v.typingAttributes = AttributedBridge.typingAttributes(m, style: style)
                return
            }
            let t = applied.toggling(kind, r.location, r.location + r.length)
            parent.onChange(t)
            load(t, selection: r)
        }

        func handle(_ e: NSEvent) -> Bool {
            let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
            let key = e.charactersIgnoringModifiers?.lowercased()
            if mods == .command {
                switch key {
                case "b": toggle(.bold)
                case "i": toggle(.italic)
                case "u": toggle(.underline)
                case "e": toggle(.code)
                default: return false
                }
                return true
            }
            if mods == [.command, .shift], key == "s" { toggle(.strikethrough); return true }
            return false
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> BasedNSTextView {
        let tv = BasedNSTextView(usingTextLayoutManager: false)
        tv.drawsBackground = false
        tv.isRichText = true
        tv.importsGraphics = false
        tv.allowsUndo = true
        tv.isHorizontallyResizable = false
        tv.isVerticallyResizable = false
        tv.textContainerInset = .zero
        tv.textContainer?.lineFragmentPadding = 0
        // Wrap at the column's text width, never at whatever frame SwiftUI hands out while negotiating the grid
        // (measured and drawn wrapping differed, so long cells were cut off).
        tv.textContainer?.widthTracksTextView = false
        tv.textContainer?.heightTracksTextView = false
        tv.textContainer?.containerSize = NSSize(width: textWidth, height: CGFloat.greatestFiniteMagnitude)
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticLinkDetectionEnabled = false
        tv.smartInsertDeleteEnabled = false
        tv.insertionPointColor = Theme.textPrimary
        tv.selectedTextAttributes = [.backgroundColor: Theme.selection]
        tv.setContentHuggingPriority(.defaultHigh, for: .vertical)
        let c = context.coordinator
        tv.delegate = c
        tv.keyEquivalentHandler = { [weak c] e in c?.handle(e) ?? false }
        tv.onFocus = { [weak c] in c?.parent.onFocus() }
        c.view = tv
        c.load(text, selection: nil)
        return tv
    }

    func updateNSView(_ tv: BasedNSTextView, context: Context) {
        let c = context.coordinator
        c.parent = self
        if tv.textContainer?.containerSize.width != textWidth {
            tv.textContainer?.containerSize = NSSize(width: textWidth, height: .greatestFiniteMagnitude)
            tv.invalidateIntrinsicContentSize()
        }
        if text != c.applied { c.load(text, selection: tv.selectedRange()) }
    }

    /// Always measured at the column's text width (not the proposal, which SwiftUI varies while negotiating the
    /// grid) — measuring at changing widths made rows jump between heights.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: BasedNSTextView, context: Context) -> CGSize? {
        CGSize(width: textWidth, height: max(20, nsView.height(forWidth: textWidth)))
    }
}
#endif
