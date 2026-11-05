import SwiftUI
import BasedCore

/// Actions shared by the block context menu and the ⋮⋮ handle menu.
@MainActor
struct BlockActions {
    let ids: [RecordID]
    let editor: EditorController
    let model: AppModel
    var store: WorkspaceStore { model.store }

    var single: Block? { ids.count == 1 ? store.blocks[ids[0]] : nil }

    func delete() {
        let order = store.visibleOrder(in: editor.pageID)
        let first = ids.compactMap { order.firstIndex(of: $0) }.min()
        store.deleteBlocks(ids)
        editor.selectedBlocks.subtract(ids)
        if let i = first, i > 0, i - 1 < order.count, store.blocks[order[i - 1]]?.type.isTextEditable == true {
            editor.focusEnd(order[i - 1])
        }
    }

    func duplicate() {
        let copies = store.duplicateBlocks(ids)
        if copies.count == 1, store.blocks[copies[0]]?.type.isTextEditable == true { editor.focusEnd(copies[0]) }
        else { editor.selectedBlocks = Set(copies) }
    }

    func turn(into type: BlockType, toggleable: Bool? = nil) {
        store.turnInto(ids, type, toggleable: toggleable)
        if type == .page, ids.count == 1 { model.open(ids[0]) }
    }

    func color(_ c: TColor) { store.setColor(ids, c == .default ? nil : c) }

    func copyMarkdown() {
        let blocks = store.documentOrder(ids).compactMap { store.blocks[$0] }
        Clipboard.copy(MarkdownExporter(store: store).exportBlocks(blocks, indent: 0))
    }

    func copyLink() {
        let target = single.flatMap { $0.type.isPageLike ? $0.id : nil } ?? editor.pageID
        Clipboard.copy("based://page/" + target)
    }

    func moveTo() { editor.picker = .move(ids) }

    func move(up: Bool) { for id in (up ? ids : ids.reversed()) { up ? store.moveUp(id) : store.moveDown(id) } }

    var canTurnInto: Bool { ids.allSatisfy { store.blocks[$0].map { TurnIntoOptions.types.contains($0.type) } ?? false } }
    var supportsToggleHeading: Bool { single.map { $0.type.isHeading } ?? false }
}

/// Context-menu form (right click / long press).
struct BlockMenuItems: View {
    let ids: [RecordID]
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        let a = BlockActions(ids: ids, editor: editor, model: model)
        if let b = a.single, b.type.isPageLike {
            Button("Open", systemImage: "arrow.up.right.square") { model.open(b.id) }
            Button("Open in side peek", systemImage: "sidebar.right") { model.open(b.id, mode: .sidePeek) }
            Divider()
        }
        if !editor.isLocked {
            Button("Delete", systemImage: "trash", role: .destructive) { a.delete() }
            Button("Duplicate", systemImage: "plus.square.on.square") { a.duplicate() }
            if a.canTurnInto {
                Menu("Turn into") {
                    ForEach(TurnIntoOptions.types, id: \.self) { t in
                        Button(t.displayName, systemImage: t.symbol) { a.turn(into: t) }
                    }
                    if a.supportsToggleHeading, let b = a.single {
                        Divider()
                        Button(b.props.toggleable == true ? "Remove toggle" : "Toggle heading") {
                            a.turn(into: b.type, toggleable: !(b.props.toggleable == true))
                        }
                    }
                }
            }
            Menu("Color") {
                Section("Text color") {
                    ForEach(TColor.textColors, id: \.self) { c in Button(c.displayName) { a.color(c) } }
                }
                Section("Background color") {
                    ForEach(TColor.backgroundColors, id: \.self) { c in Button(c.displayName) { a.color(c) } }
                }
            }
            Button("Move to…", systemImage: "arrow.turn.up.right") { a.moveTo() }
            Divider()
            Button("Move up", systemImage: "arrow.up") { a.move(up: true) }
            Button("Move down", systemImage: "arrow.down") { a.move(up: false) }
            Divider()
        }
        Button("Copy as Markdown", systemImage: "doc.on.doc") { a.copyMarkdown() }
        Button("Copy link", systemImage: "link") { a.copyLink() }
    }
}

/// Popover form with a search field (the ⋮⋮ handle menu).
struct BlockMenuView: View {
    let ids: [RecordID]
    let editor: EditorController
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var sub: Sub = .main

    enum Sub { case main, turnInto, color }

    private struct Action: Identifiable {
        var id: String { title }
        var title: String
        var symbol: String
        var shortcut: String?
        var destructive = false
        var opensSub: Sub?
        var run: () -> Void
    }

    var body: some View {
        let a = BlockActions(ids: ids, editor: editor, model: model)
        VStack(alignment: .leading, spacing: 2) {
            TextField("Search actions…", text: $query)
                .textFieldStyle(.roundedBorder)
                .padding(.bottom, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch sub {
                    case .main: rows(actions(a))
                    case .turnInto: backRow; rows(turnActions(a))
                    case .color: backRow; rows(colorActions(a))
                    }
                }
            }
            .frame(maxHeight: 380)
            if let b = a.single {
                Divider()
                Text("Last edited \(b.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(Theme.secondary).padding(.top, 2)
            }
        }
        .padding(8)
        .frame(width: 260)
    }

    private var backRow: some View {
        Button { sub = .main; query = "" } label: {
            Label("Back", systemImage: "chevron.left").frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(MenuRowStyle())
    }

    private func rows(_ list: [Action]) -> some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = q.isEmpty ? list : list.filter { $0.title.lowercased().contains(q) }
        return ForEach(filtered) { item in
            Button {
                if let s = item.opensSub { sub = s; query = ""; return }
                item.run()
                done()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: item.symbol).frame(width: 18)
                    Text(item.title)
                    Spacer()
                    if let s = item.shortcut { Text(s).font(.caption).foregroundStyle(Theme.secondary) }
                    if item.opensSub != nil { Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.secondary) }
                }
                .foregroundStyle(item.destructive ? Color.red : Theme.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(MenuRowStyle())
        }
    }

    private func actions(_ a: BlockActions) -> [Action] {
        var out: [Action] = []
        if let b = a.single, b.type.isPageLike {
            out.append(Action(title: "Open", symbol: "arrow.up.right.square") { model.open(b.id) })
        }
        if !editor.isLocked {
            out.append(Action(title: "Delete", symbol: "trash", shortcut: "Del", destructive: true) { a.delete() })
            out.append(Action(title: "Duplicate", symbol: "plus.square.on.square", shortcut: "⌘D") { a.duplicate() })
            if a.canTurnInto { out.append(Action(title: "Turn into", symbol: "arrow.triangle.2.circlepath", opensSub: .turnInto) {}) }
            out.append(Action(title: "Color", symbol: "paintpalette", opensSub: .color) {})
            out.append(Action(title: "Move to", symbol: "arrow.turn.up.right", shortcut: "⌘⇧P") { a.moveTo() })
            out.append(Action(title: "Move up", symbol: "arrow.up", shortcut: "⌘⇧↑") { a.move(up: true) })
            out.append(Action(title: "Move down", symbol: "arrow.down", shortcut: "⌘⇧↓") { a.move(up: false) })
        }
        out.append(Action(title: "Copy as Markdown", symbol: "doc.on.doc") { a.copyMarkdown() })
        out.append(Action(title: "Copy link", symbol: "link") { a.copyLink() })
        return out
    }

    private func turnActions(_ a: BlockActions) -> [Action] {
        var out = TurnIntoOptions.types.map { t in Action(title: t.displayName, symbol: t.symbol) { a.turn(into: t) } }
        if a.supportsToggleHeading, let b = a.single {
            out.append(Action(title: b.props.toggleable == true ? "Remove toggle" : "Toggle heading", symbol: "chevron.right") {
                a.turn(into: b.type, toggleable: !(b.props.toggleable == true))
            })
        }
        return out
    }

    private func colorActions(_ a: BlockActions) -> [Action] {
        (TColor.textColors + TColor.backgroundColors).map { c in
            Action(title: c.displayName, symbol: c.isBackground ? "a.square.fill" : "a.square") { a.color(c) }
        }
    }
}

/// Hover-highlighted row used by popover menus.
struct MenuRowStyle: ButtonStyle {
    var highlighted = false
    func makeBody(configuration: Configuration) -> some View {
        MenuRowBody(configuration: configuration, highlighted: highlighted)
    }

    private struct MenuRowBody: View {
        let configuration: ButtonStyleConfiguration
        let highlighted: Bool
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 14))
                .padding(.horizontal, 6)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(highlighted || hover || configuration.isPressed ? 0.08 : 0)))
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}

/// ⌘K link editor for the selected text.
struct LinkEditorView: View {
    let editor: EditorController
    let blockID: RecordID
    @Environment(AppModel.self) private var model
    @State private var url = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Paste link or search pages", text: $url)
                .textFieldStyle(.roundedBorder)
                .onSubmit { apply(url) }
            let hits = url.hasPrefix("http") || url.isEmpty ? [] :
                SearchEngine(store: model.store).search(url, filters: { var f = SearchFilters(); f.titleOnly = true; return f }(), limit: 6)
            ForEach(hits) { h in
                Button {
                    apply("based://page/" + h.pageID)
                } label: {
                    HStack {
                        PageIconView(icon: model.store.icon(of: h.pageID), size: 14)
                        Text(model.store.title(of: h.pageID))
                        Spacer()
                    }
                }
                .buttonStyle(MenuRowStyle())
            }
            HStack {
                if editor.currentLink() != nil {
                    Button("Remove link", role: .destructive) { editor.setLink(nil); close() }
                }
                Spacer()
                Button("Done") { apply(url) }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(10)
        .frame(width: 320)
        .onAppear { url = editor.currentLink() ?? "" }
    }

    private func apply(_ link: String) {
        editor.setLink(link.isEmpty ? nil : link)
        close()
    }

    private func close() {
        editor.linkEditor = nil
        editor.focus(FocusTarget(blockID, editor.host(blockID)?.selectedRange().location ?? 0))
    }
}

/// The slash / @ / [[ / : menu shown under the block being typed in.
struct InlineMenuView: View {
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        let items = editor.menuItems()
        let highlighted = editor.menu?.highlighted ?? 0
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                Text("No results").foregroundStyle(Theme.secondary).padding(10)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                                if let header = sectionHeader(items, i) {
                                    Text(header).font(.caption).foregroundStyle(Theme.secondary)
                                        .padding(.horizontal, 8).padding(.top, i == 0 ? 6 : 10).padding(.bottom, 2)
                                }
                                Button { editor.choose(item) } label: { row(item) }
                                    .buttonStyle(MenuRowStyle(highlighted: i == highlighted))
                                    .id(item.id)
                            }
                        }
                        .padding(4)
                    }
                    .onChange(of: highlighted) { _, h in
                        if h < items.count { proxy.scrollTo(items[h].id) }
                    }
                }
            }
        }
        .frame(width: 320)
        .frame(maxHeight: 360)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 8).fill(.background).shadow(color: .black.opacity(0.18), radius: 10, y: 4))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(Theme.divider)))
    }

    private func sectionHeader(_ items: [MenuItem], _ i: Int) -> String? {
        switch items[i] {
        case .command(let c):
            if i > 0, case .command(let p) = items[i - 1], p.section == c.section { return nil }
            return c.section.rawValue
        case .date:
            if i > 0, case .date = items[i - 1] { return nil }
            return "Date"
        case .person:
            return "People"
        case .page:
            if i > 0, case .page = items[i - 1] { return nil }
            if i > 0, case .newPage = items[i - 1] { return nil }
            return "Link to page"
        case .newPage:
            return i == 0 ? "Link to page" : nil
        case .emoji:
            return i == 0 ? "Emoji" : nil
        }
    }

    @ViewBuilder
    private func row(_ item: MenuItem) -> some View {
        HStack(spacing: 10) {
            switch item {
            case .command(let c):
                Image(systemName: c.symbol)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 6).stroke(Color(Theme.divider)))
                VStack(alignment: .leading, spacing: 1) {
                    Text(c.title)
                    Text(c.subtitle).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
                }
                Spacer()
                if let s = c.shortcut { Text(s).font(.caption).foregroundStyle(Theme.secondary) }
            case .page(let pid):
                PageIconView(icon: model.store.icon(of: pid), isDatabase: model.store.blocks[pid]?.type == .databasePage, size: 16)
                Text(model.store.title(of: pid)).lineLimit(1)
                Spacer()
            case .newPage(let t):
                Image(systemName: "plus")
                Text(t.isEmpty ? "New page" : "New \"\(t)\" sub-page").lineLimit(1)
                Spacer()
            case .date(_, let label):
                Image(systemName: "calendar")
                Text(label)
                Spacer()
            case .person:
                Image(systemName: "person.crop.circle")
                Text("Me")
                Spacer()
            case .emoji(let e, let name):
                Text(e).font(.system(size: 20))
                Text(name).lineLimit(1)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}