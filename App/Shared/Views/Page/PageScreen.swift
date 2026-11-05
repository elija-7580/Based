import SwiftUI
import BasedCore

/// A full page: cover, icon, title, properties (for rows) and the block editor.
struct PageScreen: View {
    let pageID: RecordID
    var isPeek = false
    @Environment(AppModel.self) private var model
    @State private var editor: EditorController
    @FocusState private var keyFocus: Bool

    init(pageID: RecordID, model: AppModel, isPeek: Bool = false) {
        self.pageID = pageID
        self.isPeek = isPeek
        _editor = State(initialValue: EditorController(pageID: pageID, model: model))
    }

    var body: some View {
        let node = model.registry.block(pageID)
        if let page = node.block {
            pageBody(page)
        } else {
            ContentUnavailableView("Page not found", systemImage: "doc.questionmark",
                                   description: Text("It may have been deleted permanently."))
        }
    }

    @ViewBuilder
    private func pageBody(_ page: Block) -> some View {
        @Bindable var ed = editor
        let format = page.props.format
        let fullWidth = format?.fullWidth == true || page.type == .databasePage
        VStack(spacing: 0) {
            if model.store.isTrashed(pageID) { TrashBanner(pageID: pageID) }
            if page.props.isTemplate == true { TemplateBanner(page: page) }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    PageHeader(page: page, editor: editor, isPeek: isPeek)
                    VStack(alignment: .leading, spacing: 0) {
                        if page.isRow || page.props.isTemplate == true, let db = model.store.database(ofRow: pageID) {
                            RowPropertiesPanel(db: db, row: page, locked: editor.isLocked || db.locked == true)
                                .padding(.bottom, 12)
                        }
                        if format?.hideBacklinks != true { BacklinksView(pageID: pageID) }
                        if page.type == .databasePage {
                            DatabaseBlockView(blockID: pageID, fullPage: true)
                        } else {
                            BlockList(parentID: pageID, editor: editor)
                            Color.clear
                                .frame(height: 160)
                                .frame(maxWidth: .infinity)
                                .contentShape(Rectangle())
                                .onTapGesture { if !editor.isLocked { editor.selectedBlocks = []; editor.focusEndOfPage() } }
                        }
                    }
                    .padding(.horizontal, horizontalPadding)
                }
                .frame(maxWidth: fullWidth ? .infinity : Theme.contentWidth + 2 * horizontalPadding, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(Color.clear.contentShape(Rectangle()).onTapGesture { editor.selectedBlocks = [] })
            .overlayPreferenceValue(MenuAnchorKey.self) { anchor in
                GeometryReader { geo in
                    if let anchor, editor.menu != nil {
                        let r = geo[anchor]
                        let below = r.maxY + 4
                        let fitsBelow = below + 360 < geo.size.height
                        InlineMenuView(editor: editor)
                            .offset(x: min(max(0, r.minX + 24), max(0, geo.size.width - 330)),
                                    y: fitsBelow ? below : max(0, r.minY - 364))
                    }
                }
            }
        }
        .focusable()
        .focused($keyFocus)
        .focusEffectDisabled()
        .onKeyPress(.escape) {
            if editor.menu != nil { editor.menu = nil; return .handled }
            if !editor.selectedBlocks.isEmpty { editor.selectedBlocks = []; return .handled }
            return .ignored
        }
        .onKeyPress(.delete) { deleteSelection() }
        .onKeyPress(.deleteForward) { deleteSelection() }
        .onKeyPress(.return) {
            guard editor.selectedBlocks.count == 1, let id = editor.selectedBlocks.first else { return .ignored }
            editor.selectedBlocks = []
            editor.focusEnd(id)
            return .handled
        }
        .onChange(of: editor.selectedBlocks) { _, s in if !s.isEmpty { keyFocus = true } }
        .sheet(item: $ed.picker) { purpose in
            PagePicker(purpose: purpose) { editor.picker = nil }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if !isPeek {
                    FavoriteButton(pageID: page.id)
                    PageMenu(page: page, editor: editor)
                }
            }
        }
        #if os(macOS)
        .navigationTitle(isPeek ? "" : model.store.title(of: pageID))
        #else
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            editor.format = format
            model.activeEditor = editor
        }
        .onChange(of: page.props.format) { _, f in editor.format = f }
        .onDisappear { if model.activeEditor === editor { model.activeEditor = nil } }
    }

    private var horizontalPadding: CGFloat {
        #if os(macOS)
        return isPeek ? 36 : 72
        #else
        return 20
        #endif
    }

    private func deleteSelection() -> KeyPress.Result {
        guard !editor.selectedBlocks.isEmpty, !editor.isLocked else { return .ignored }
        editor.deleteSelection()
        return .handled
    }
}

// MARK: - Header

struct PageHeader: View {
    let page: Block
    let editor: EditorController
    var isPeek = false
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var iconPicker = false
    @State private var coverPicker = false

    private var store: WorkspaceStore { model.store }
    private var locked: Bool { editor.isLocked }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let cover = page.props.cover {
                CoverView(cover: cover)
                    .frame(height: isPeek ? 140 : 220)
                    .overlay(alignment: .bottomTrailing) {
                        if hover, !locked {
                            HStack(spacing: 0) {
                                Button("Change cover") { coverPicker = true }
                                Divider().frame(height: 14)
                                Button("Remove") { store.setPageCover(page.id, nil) }
                            }
                            .buttonStyle(.plain)
                            .font(.system(size: 12))
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(RoundedRectangle(cornerRadius: 4).fill(.regularMaterial))
                            .padding(10)
                        }
                    }
            } else {
                Color.clear.frame(height: isPeek ? 24 : 56)
            }
            VStack(alignment: .leading, spacing: 6) {
                if let icon = page.props.icon {
                    Button { if !locked { iconPicker = true } } label: {
                        icon.view(size: 78, assets: model.assets).frame(width: 84, height: 84, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .offset(y: page.props.cover != nil ? -42 : 0)
                    .padding(.bottom, page.props.cover != nil ? -42 : 0)
                }
                if !locked {
                    HStack(spacing: 12) {
                        if page.props.icon == nil {
                            Button { store.setPageIcon(page.id, .emoji(EmojiCatalog.random())) } label: { Label("Add icon", systemImage: "face.smiling") }
                        }
                        if page.props.cover == nil {
                            Button { store.setPageCover(page.id, .gradient(Int.random(in: 0..<Covers.gradients.count))) } label: { Label("Add cover", systemImage: "photo") }
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.secondary)
                    .opacity(hover ? 1 : 0)
                    .frame(height: 22)
                }
                title
                    .padding(.bottom, 8)
            }
            .padding(.horizontal, horizontalPadding)
        }
        .onHover { hover = $0 }
        .popover(isPresented: $iconPicker) {
            IconPicker(current: page.props.icon) { store.setPageIcon(page.id, $0); iconPicker = false }
        }
        .popover(isPresented: $coverPicker) {
            CoverPicker(current: page.props.cover) { store.setPageCover(page.id, $0); coverPicker = false }
        }
        #if os(iOS)
        .onAppear { hover = true }
        #endif
    }

    @ViewBuilder
    private var title: some View {
        if page.type == .databasePage, let db = store.database(forBlock: page.id) {
            DatabaseTitleField(db: db, locked: locked, size: format?.smallText == true ? 32 : 40)
        } else {
            let style = TextStyle(type: .page, format: format)
            RichTextView(id: page.id, text: page.text, config: {
                var c = RichTextConfig(style: style)
                c.placeholder = "Untitled"
                c.alwaysShowPlaceholder = true
                c.editable = !locked
                return c
            }(), controller: editor)
        }
    }

    private var format: PageFormat? { page.props.format }

    private var horizontalPadding: CGFloat {
        #if os(macOS)
        return isPeek ? 36 : 72
        #else
        return 20
        #endif
    }
}

// MARK: - Row properties

/// Property list shown under the title of a database row.
struct RowPropertiesPanel: View {
    let db: Database
    let row: Block
    var locked = false
    @Environment(AppModel.self) private var model
    @State private var hideEmpty = false
    @State private var adding = false

    var body: some View {
        let _ = model.registry.database(db.id).revision
        let live = model.store.databases[db.id] ?? db
        let engine = QueryEngine(store: model.store)
        let props = live.properties.filter { $0.type != .title }
        VStack(alignment: .leading, spacing: 2) {
            ForEach(props) { p in
                let v = engine.value(row, p, live)
                if !(hideEmpty && v.isEmpty) {
                    HStack(alignment: .top, spacing: 8) {
                        Label(p.name, systemImage: p.type.symbol)
                            .lineLimit(1)
                            .foregroundStyle(Theme.secondary)
                            .frame(width: 160, alignment: .leading)
                            .help(p.description ?? p.type.displayName)
                        PropertyCell(db: live, row: row, property: p, value: v, locked: locked, wrap: true, placeholder: "Empty")
                    }
                    .font(.system(size: 14))
                    .padding(.vertical, 3)
                }
            }
            HStack(spacing: 14) {
                if !locked {
                    Button { adding = true } label: { Label("Add a property", systemImage: "plus") }
                        .popover(isPresented: $adding) { AddRowPropertyMenu(db: live) { adding = false } }
                }
                Button(hideEmpty ? "Show all properties" : "Hide empty properties") { hideEmpty.toggle() }
            }
            .buttonStyle(.plain)
            .font(.system(size: 13))
            .foregroundStyle(Theme.secondary)
            .padding(.top, 4)
            Divider().padding(.top, 8)
        }
    }
}

struct AddRowPropertyMenu: View {
    let db: Database
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var created: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let id = created {
                PropertyConfigEditor(db: db, propertyID: id)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(PropertyType.creatable, id: \.self) { t in
                            Button {
                                created = model.store.addProperty(to: db.id, name: t.displayName, type: t)
                                if created == nil { done() }
                            } label: {
                                Label(t.displayName, systemImage: t.symbol).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(MenuRowStyle())
                        }
                    }
                }
                .frame(maxHeight: 360)
            }
        }
        .padding(10)
        .frame(width: 280)
    }
}

// MARK: - Backlinks / banners

struct BacklinksView: View {
    let pageID: RecordID
    @Environment(AppModel.self) private var model
    @State private var open = false

    var body: some View {
        let _ = model.registry.workspace.revision
        let links = model.store.backlinks(to: pageID)
        if !links.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Button { open.toggle() } label: {
                    Label("\(links.count) backlink\(links.count == 1 ? "" : "s")", systemImage: "arrow.uturn.left")
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
                if open {
                    ForEach(links, id: \.self) { id in
                        Button { model.open(id) } label: {
                            HStack(spacing: 4) {
                                PageIconView(icon: model.store.icon(of: id), size: 14)
                                Text(model.store.title(of: id)).underline(color: Theme.secondary.opacity(0.4))
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.leading, 18)
                    }
                }
            }
            .font(.system(size: 13))
            .padding(.bottom, 10)
        }
    }
}

struct TrashBanner: View {
    let pageID: RecordID
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack {
            Text("This page is in Trash.")
            Spacer()
            Button("Restore page") { model.store.restore([pageID]) }
            Button("Delete from Trash", role: .destructive) {
                model.store.deleteForever([pageID])
                model.goBack()
            }
        }
        .buttonStyle(.bordered)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(.white)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Color.red.opacity(0.85))
    }
}

struct TemplateBanner: View {
    let page: Block
    @Environment(AppModel.self) private var model

    var body: some View {
        let db = model.store.database(ofRow: page.id)
        HStack {
            Image(systemName: "doc.badge.gearshape")
            Text("You're editing a template in \(db.map { $0.title.plainText.isEmpty ? "Untitled" : $0.title.plainText } ?? "a database").")
            Spacer()
            if let db {
                Button(db.defaultTemplateID == page.id ? "Default template" : "Set as default") {
                    model.store.updateDatabase(db.id, name: "Default template") { $0.defaultTemplateID = page.id }
                }
                .disabled(db.defaultTemplateID == page.id)
            }
        }
        .font(.system(size: 13))
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.12))
    }
}

// MARK: - Toolbar

struct FavoriteButton: View {
    let pageID: RecordID
    @Environment(AppModel.self) private var model

    var body: some View {
        let _ = model.registry.workspace.revision
        let fav = model.store.isFavorite(pageID)
        Button { model.store.toggleFavorite(pageID) } label: { Image(systemName: fav ? "star.fill" : "star") }
            .help(fav ? "Remove from Favorites" : "Add to Favorites")
    }
}

/// The "•••" page menu (style, width, lock, export…).
struct PageMenu: View {
    let page: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.store
        let f = page.props.format ?? PageFormat()
        Menu {
            Picker("Font", selection: Binding(get: { f.font ?? .default }, set: { v in store.setPageFormat(page.id) { $0.font = v == .default ? nil : v } })) {
                Text("Default").tag(PageFont.default)
                Text("Serif").tag(PageFont.serif)
                Text("Mono").tag(PageFont.mono)
            }
            Toggle("Small text", isOn: Binding(get: { f.smallText == true }, set: { v in store.setPageFormat(page.id) { $0.smallText = v ? true : nil } }))
            Toggle("Full width", isOn: Binding(get: { f.fullWidth == true }, set: { v in store.setPageFormat(page.id) { $0.fullWidth = v ? true : nil } }))
            Toggle("Lock page", isOn: Binding(get: { f.locked == true }, set: { v in store.setPageFormat(page.id) { $0.locked = v ? true : nil } }))
            Toggle("Show backlinks", isOn: Binding(get: { f.hideBacklinks != true }, set: { v in store.setPageFormat(page.id) { $0.hideBacklinks = v ? nil : true } }))
            Divider()
            Button("Copy link", systemImage: "link") { Clipboard.copy("based://page/" + page.id) }
            Button("Duplicate", systemImage: "plus.square.on.square") {
                if let id = store.duplicateBlocks([page.id]).first { model.open(id) }
            }
            Button("Move to…", systemImage: "arrow.turn.up.right") { editor.picker = .move([page.id]) }
            Button("Delete", systemImage: "trash", role: .destructive) { model.trash(page.id) }
            Divider()
            Button("Undo", systemImage: "arrow.uturn.backward") { model.undo() }.disabled(!store.canUndo)
            Button("Export…", systemImage: "square.and.arrow.up") { model.exportRequest = AppModel.ExportRequest(pageID: page.id) }
            Divider()
            Text("Last edited \(page.updatedAt.formatted(date: .abbreviated, time: .shortened))")
            Text("Word count: \(wordCount)")
        } label: {
            Image(systemName: "ellipsis.circle")
        }
    }

    private var wordCount: Int {
        model.store.descendants(of: page.id, includeRows: false)
            .compactMap { model.store.blocks[$0]?.text.plainText }
            .reduce(0) { $0 + $1.split { $0.isWhitespace || $0.isNewline }.count }
    }
}

// MARK: - Peek

/// Side / center peek around a page.
struct PeekView: View {
    let pageID: RecordID
    let mode: OpenMode
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { model.peek = nil } label: { Image(systemName: mode == .sidePeek ? "chevron.right.2" : "xmark") }
                    .help("Close")
                Button { model.open(pageID, mode: .fullPage) } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .help("Open as full page")
                Button {
                    model.peek = mode == .sidePeek ? .center(pageID) : .side(pageID)
                } label: { Image(systemName: mode == .sidePeek ? "rectangle.center.inset.filled" : "sidebar.right") }
                .help(mode == .sidePeek ? "Center peek" : "Side peek")
                Spacer()
                BreadcrumbView(pageID: pageID)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            PageScreen(pageID: pageID, model: model, isPeek: true)
                .id(pageID)
        }
        #if os(macOS)
        .frame(minWidth: mode == .centerPeek ? 760 : 360, minHeight: mode == .centerPeek ? 560 : 300)
        #endif
    }
}