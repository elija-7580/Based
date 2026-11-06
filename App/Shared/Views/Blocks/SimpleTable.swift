import SwiftUI
import BasedCore

/// Notion's "simple table" block: a grid of text cells with optional header row / column.
struct SimpleTableView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var hoverBottom = false
    @State private var hoverRight = false

    private var store: WorkspaceStore { model.store }
    private var columns: Int { max(1, block.props.tableColumns ?? 1) }
    private var locked: Bool { editor.isLocked }

    var body: some View {
        let node = model.registry.block(block.id)
        let rows = node.children.compactMap { model.registry.block($0).block }.filter { $0.type == .tableRow }
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { r, row in
                            GridRow {
                                ForEach(0..<columns, id: \.self) { c in
                                    cell(row: row, r: r, c: c, rowCount: rows.count)
                                }
                            }
                        }
                    }
                    .overlay(Rectangle().stroke(Color(Theme.divider)))
                }
                if !locked {
                    addButton(vertical: true) { addColumn(at: columns) }
                        .opacity(hoverRight ? 1 : 0.001)
                        .onHover { hoverRight = $0 }
                }
            }
            if !locked {
                addButton(vertical: false) { addRow(after: rows.last?.id) }
                    .opacity(hoverBottom ? 1 : 0.001)
                    .onHover { hoverBottom = $0 }
            }
        }
    }

    private func addButton(vertical: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "plus").font(.system(size: 11))
                .frame(maxWidth: vertical ? 18 : .infinity, maxHeight: vertical ? .infinity : 18)
                .frame(width: vertical ? 18 : nil, height: vertical ? nil : 18)
                .background(Color.primary.opacity(0.05))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func cell(row: Block, r: Int, c: Int, rowCount: Int) -> some View {
        let header = (block.props.tableHeaderRow == true && r == 0) || (block.props.tableHeaderColumn == true && c == 0)
        let text = (row.props.cells ?? []).indices.contains(c) ? row.props.cells![c] : RichText()
        TableCellField(text: text, bold: header, editable: !locked, onFocus: { editor.selectedBlocks = [] }) { new in
            store.updateBlock(row.id, name: "Edit cell", coalesce: "cell-\(row.id)-\(c)") { b in
                var cells = b.props.cells ?? []
                while cells.count <= c { cells.append(RichText()) }
                cells[c] = new
                b.props.cells = cells
            }
        }
        .frame(width: 140, alignment: .topLeading)
        .frame(minHeight: 34)
        .background(header ? Color.primary.opacity(0.04) : Color.clear)
        .overlay(Rectangle().stroke(Color(Theme.divider), lineWidth: 0.5))
        .contextMenu {
            if !locked {
                Button("Insert row above") { addRow(before: row.id) }
                Button("Insert row below") { addRow(after: row.id) }
                Button("Insert column left") { addColumn(at: c) }
                Button("Insert column right") { addColumn(at: c + 1) }
                Divider()
                Button(block.props.tableHeaderRow == true ? "Remove header row" : "Header row") {
                    store.updateBlock(block.id, name: "Header row") { $0.props.tableHeaderRow = !($0.props.tableHeaderRow == true) }
                }
                Button(block.props.tableHeaderColumn == true ? "Remove header column" : "Header column") {
                    store.updateBlock(block.id, name: "Header column") { $0.props.tableHeaderColumn = !($0.props.tableHeaderColumn == true) }
                }
                Divider()
                Button("Delete row", role: .destructive) { if rowCount > 1 { store.deleteBlocks([row.id]) } }
                Button("Delete column", role: .destructive) { deleteColumn(c) }
                Divider()
                Button("Clear cell") {
                    store.updateBlock(row.id, name: "Clear cell") { b in
                        if var cells = b.props.cells, cells.indices.contains(c) { cells[c] = RichText(); b.props.cells = cells }
                    }
                }
            }
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
            tx.update(block.id) { $0.props.tableColumns = columns + 1 }
            for id in rowIDs {
                tx.update(id) { b in
                    var cells = b.props.cells ?? []
                    while cells.count < columns { cells.append(RichText()) }
                    cells.insert(RichText(), at: min(index, cells.count))
                    b.props.cells = cells
                }
            }
        }
    }

    private func deleteColumn(_ index: Int) {
        guard columns > 1 else { return }
        let rowIDs = store.children(of: .block(block.id))
        store.transact("Delete column") { tx in
            tx.update(block.id) { $0.props.tableColumns = columns - 1 }
            for id in rowIDs {
                tx.update(id) { b in
                    var cells = b.props.cells ?? []
                    if cells.indices.contains(index) { cells.remove(at: index) }
                    b.props.cells = cells
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
    var onFocus: () -> Void = {}
    let onChange: (RichText) -> Void
    #if !os(macOS)
    @State private var draft = ""
    #endif

    var body: some View {
        Group {
            #if os(macOS)
            if editable {
                TableCellTextView(text: text, header: bold, onFocus: onFocus, onChange: onChange)
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
        .padding(.horizontal, 8)
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
    var onFocus: () -> Void = {}
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
        tv.textContainer?.widthTracksTextView = true
        tv.textContainer?.heightTracksTextView = false
        tv.textContainer?.containerSize = NSSize(width: 124, height: CGFloat.greatestFiniteMagnitude)
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
        if text != c.applied { c.load(text, selection: tv.selectedRange()) }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: BasedNSTextView, context: Context) -> CGSize? {
        var w = proposal.width ?? 124
        if !w.isFinite || w <= 0 { w = 124 }
        return CGSize(width: w, height: max(20, nsView.height(forWidth: w)))
    }
}
#endif
