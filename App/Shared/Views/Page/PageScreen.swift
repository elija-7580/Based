import SwiftUI
import BasedCore

/// A full page: cover, icon, title, properties (for rows) and the block editor.
struct PageScreen: View {
    let pageID: RecordID
    var isPeek = false
    @Environment(AppModel.self) private var model
    @State private var editor: EditorController
    @FocusState private var keyFocus: Bool
    /// Width of the scroll area (Notion: 708 pt text column with 96 pt side padding, less in narrow windows).
    @State private var availableWidth: CGFloat = 1000
    /// Height of the scroll area; the cover is 30 % of it (clamped like Notion's 30vh cover).
    @State private var availableHeight: CGFloat = 800
    @State private var fileDropTargeted = false

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
            #if os(macOS)
            if !isPeek { PageTopBar(page: page, editor: editor) }
            #endif
            if model.store.isTrashed(pageID) { TrashBanner(pageID: pageID) }
            if page.props.isTemplate == true { TemplateBanner(page: page) }
            ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // Notion: the cover spans the whole content area edge to edge; icon, title and blocks
                    // share one left edge inside the centred text column below it.
                    PageCoverArea(page: page, locked: editor.isLocked, height: coverHeight)
                    VStack(alignment: .leading, spacing: 0) {
                        PageHeader(page: page, editor: editor, isPeek: isPeek)
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
                    .frame(maxWidth: fullWidth ? .infinity : Theme.contentWidth + 2 * horizontalPadding, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { availableWidth = g.size.width; availableHeight = g.size.height }
                    .onChange(of: g.size.width) { _, w in availableWidth = w }
                    .onChange(of: g.size.height) { _, h in availableHeight = h }
            })
            // Files dragged in from Finder / Files become blocks (HTML renders inline as an embed).
            .onDrop(of: [.fileURL], isTargeted: $fileDropTargeted) { providers in
                guard !editor.isLocked, page.type != .databasePage else { return false }
                return FileDrop.insert(providers, into: pageID, after: editor.selectedBlocks.first ?? editor.focusedID, model: model)
            }
            .overlay {
                if fileDropTargeted {
                    RoundedRectangle(cornerRadius: 6).stroke(Color.accentColor.opacity(0.6), lineWidth: 2).padding(4)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .topTrailing) {
                if page.type != .databasePage, format?.hideOutline != true, !model.showFind { PageOutline(pageID: pageID, scroll: scroll) }
            }
            .onChange(of: model.findTarget) { _, target in
                // ⌘F: scroll the current match into view and mark it.
                guard !isPeek, let target, model.store.containingPage(of: target) == pageID else { return }
                withAnimation(.easeOut(duration: 0.15)) { scroll.scrollTo(target, anchor: .center) }
                editor.selectedBlocks = [target]
            }
            }
            .background(Color.clear.contentShape(Rectangle()).onTapGesture { editor.selectedBlocks = [] })
            .overlayPreferenceValue(MenuAnchorKey.self) { anchor in
                GeometryReader { geo in
                    if let anchor, editor.menu != nil {
                        let r = geo[anchor]
                        let below = r.maxY + 4
                        let fitsBelow = below + 360 < geo.size.height
                        InlineMenuView(editor: editor)
                            .accessibilityIdentifier("slash.menu")
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
        #if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if !isPeek {
                    FavoriteButton(pageID: page.id)
                    PageMenu(page: page, editor: editor)
                }
            }
        }
        .navigationTitle(isPeek ? "" : model.store.title(of: pageID))
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            editor.format = format
            model.activeEditor = editor
        }
        .onChange(of: page.props.format) { _, f in editor.format = f }
        .onDisappear { if model.activeEditor === editor { model.activeEditor = nil } }
    }

    private var coverHeight: CGFloat {
        if isPeek { return 140 }
        #if os(macOS)
        return min(280, max(200, availableHeight * 0.3))
        #else
        return min(240, max(160, availableHeight * 0.25))
        #endif
    }

    private var horizontalPadding: CGFloat {
        #if os(macOS)
        if isPeek { return max(24, min(52, (availableWidth - Theme.contentWidth) / 2)) }
        return max(24, min(96, (availableWidth - Theme.contentWidth) / 2))
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

/// Full-bleed page cover with hover controls (Change cover · Reposition · Remove), Notion-style.
struct PageCoverArea: View {
    let page: Block
    var locked = false
    var height: CGFloat
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var coverPicker = false
    @State private var repositioning = false
    /// Position while dragging in reposition mode (0 = top, 1 = bottom).
    @State private var draft: Double?
    @State private var dragStart: Double?
    @State private var overflow: CGFloat = 0

    private var store: WorkspaceStore { model.store }
    private var saved: Double { page.props.format?.coverPosition ?? 0.5 }
    private var canReposition: Bool {
        switch page.props.cover {
        case .asset, .url: return true
        default: return false
        }
    }

    var body: some View {
        if let cover = page.props.cover {
            CoverView(cover: cover, position: draft ?? saved, onOverflow: { o in if abs(o - overflow) > 0.5 { overflow = o } })
                .frame(height: height)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .gesture(repositionGesture, including: repositioning ? .all : .subviews)
                .overlay {
                    if repositioning {
                        Text("Drag image to reposition")
                            .font(.system(size: 13, weight: .medium))
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Capsule().fill(.black.opacity(0.45)))
                            .foregroundStyle(.white)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if (hover || repositioning), !locked { controls }
                }
                .onHover { hover = $0 }
                .popover(isPresented: $coverPicker) {
                    CoverPicker(current: page.props.cover) { store.setPageCover(page.id, $0); coverPicker = false }
                }
                .accessibilityIdentifier("page.cover")
                #if os(iOS)
                .onAppear { hover = true }
                #endif
        }
    }

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: 0) {
            if repositioning {
                coverButton("Save position") {
                    if let d = draft { store.setPageFormat(page.id) { $0.coverPosition = d } }
                    draft = nil; repositioning = false
                }
                Divider().frame(height: 14)
                coverButton("Cancel") { draft = nil; repositioning = false }
            } else {
                coverButton("Change cover") { coverPicker = true }
                if canReposition {
                    Divider().frame(height: 14)
                    coverButton("Reposition") { draft = saved; repositioning = true }
                }
                Divider().frame(height: 14)
                coverButton("Remove") { store.setPageCover(page.id, nil) }
            }
        }
        .background(RoundedRectangle(cornerRadius: 4).fill(.regularMaterial))
        .padding(10)
    }

    private func coverButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(.system(size: 12))
            .padding(.horizontal, 8).padding(.vertical, 4)
            .contentShape(Rectangle())
    }

    private var repositionGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { v in
                guard repositioning else { return }
                let start = dragStart ?? (draft ?? saved)
                if dragStart == nil { dragStart = start }
                guard overflow > 0 else { return }
                // Dragging the image down reveals more of its top, like Notion.
                draft = min(1, max(0, start - Double(v.translation.height / overflow)))
            }
            .onEnded { _ in dragStart = nil }
    }
}

/// Icon, "Add icon / Add cover" hover controls and the title. Lives inside the text column, so all three
/// share the left edge of the blocks below.
struct PageHeader: View {
    let page: Block
    let editor: EditorController
    var isPeek = false
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var iconPicker = false

    static let iconSize: CGFloat = 78

    private var store: WorkspaceStore { model.store }
    private var locked: Bool { editor.isLocked }
    private var hasCover: Bool { page.props.cover != nil }
    private var hasIcon: Bool { page.props.icon != nil }
    /// Only reserve the controls row when it has something to offer (Notion collapses it otherwise).
    private var showsControls: Bool { !locked && (!hasIcon || !hasCover) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !hasCover {
                Color.clear.frame(height: isPeek ? 24 : (hasIcon ? 48 : 64))
            }
            if let icon = page.props.icon {
                Button { if !locked { iconPicker = true } } label: {
                    icon.view(size: Self.iconSize, assets: model.assets)
                        .frame(width: Self.iconSize, height: Self.iconSize, alignment: .center)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("page.icon")
                // Overlap the cover's bottom edge by half the icon height.
                .offset(y: hasCover ? -Self.iconSize / 2 : 0)
                .padding(.bottom, hasCover ? -Self.iconSize / 2 : 0)
                .popover(isPresented: $iconPicker) {
                    IconPicker(current: page.props.icon) { store.setPageIcon(page.id, $0); iconPicker = false }
                }
            }
            if showsControls {
                HStack(spacing: 12) {
                    if !hasIcon {
                        Button { store.setPageIcon(page.id, .emoji(EmojiCatalog.random())) } label: { Label("Add icon", systemImage: "face.smiling") }
                    }
                    if !hasCover {
                        Button { store.setPageCover(page.id, .gradient(Int.random(in: 0..<Covers.gradients.count))) } label: { Label("Add cover", systemImage: "photo") }
                    }
                }
                .buttonStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(Theme.secondary)
                .opacity(hover ? 1 : 0)
                .frame(height: 24)
                .padding(.top, hasIcon ? 8 : (hasCover ? 12 : 0))
                .padding(.bottom, 4)
            } else {
                Color.clear.frame(height: hasIcon ? 10 : 24)
            }
            title
                .padding(.bottom, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
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
            .accessibilityIdentifier("page.title")
        }
    }

    private var format: PageFormat? { page.props.format }
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
        let _ = model.registry.workspace.structureRevision
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
            Toggle("Outline", isOn: Binding(get: { f.hideOutline != true }, set: { v in store.setPageFormat(page.id) { $0.hideOutline = v ? nil : true } }))
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

/// Side / center peek around a page. Rows opened from a database get ↑ / ↓ to step through the view.
struct PeekView: View {
    let pageID: RecordID
    let mode: OpenMode
    @Environment(AppModel.self) private var model

    var body: some View {
        let siblings = model.peekSiblings
        let index = siblings.firstIndex(of: pageID)
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { model.peek = nil } label: { Image(systemName: mode == .sidePeek ? "chevron.right.2" : "xmark") }
                    .help("Close (Esc)")
                    .accessibilityIdentifier("peek.close")
                Button { model.open(pageID, mode: .fullPage) } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .help("Open as full page")
                Button {
                    model.peek = mode == .sidePeek ? .center(pageID) : .side(pageID)
                } label: { Image(systemName: mode == .sidePeek ? "rectangle.center.inset.filled" : "sidebar.right") }
                .help(mode == .sidePeek ? "Center peek" : "Side peek")
                if let index {
                    Divider().frame(height: 14)
                    Button { step(siblings, index - 1) } label: { Image(systemName: "chevron.up") }
                        .disabled(index == 0).help("Previous row")
                        .keyboardShortcut(.upArrow, modifiers: [.control, .shift])
                    Button { step(siblings, index + 1) } label: { Image(systemName: "chevron.down") }
                        .disabled(index >= siblings.count - 1).help("Next row")
                        .keyboardShortcut(.downArrow, modifiers: [.control, .shift])
                }
                Spacer(minLength: 8)
                BreadcrumbView(pageID: pageID)
                    .lineLimit(1)
                    .layoutPriority(-1)
                FavoriteButton(pageID: pageID)
                Button { model.openInNewTab(pageID) } label: { Image(systemName: "plus.square.on.square") }
                    .help("Open in new tab")
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, 12)
            .frame(height: 40)
            Divider()
            PageScreen(pageID: pageID, model: model, isPeek: true)
                .id(pageID)
        }
        .background(.background)
        #if os(macOS)
        .frame(minWidth: 300, minHeight: 240)
        #endif
    }

    private func step(_ siblings: [RecordID], _ i: Int) {
        guard siblings.indices.contains(i) else { return }
        model.peek = mode == .sidePeek ? .side(siblings[i]) : .center(siblings[i])
    }
}
