import SwiftUI
import BasedCore

/// A full page: cover, icon, title, properties (for rows) and the block editor.
struct PageScreen: View {
    let pageID: RecordID
    var isPeek = false
    @Environment(AppModel.self) private var model
    @State private var editor: EditorController
    @FocusState private var keyFocus: Bool
    #if os(macOS)
    @State private var selectionKeys = BlockSelectionKeys()
    #endif
    /// Width of the scroll area (Notion: 708 pt text column with 96 pt side padding, less in narrow windows).
    @State private var availableWidth: CGFloat = 1000

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
                VStack(spacing: 0) {
                if let cover = page.props.cover {
                    // Notion: the cover spans the whole page area, edge to edge — never clipped to the column.
                    PageCoverView(page: page, cover: cover, locked: editor.isLocked, isPeek: isPeek)
                }
                VStack(alignment: .leading, spacing: 0) {
                    PageHeader(page: page, editor: editor, isPeek: isPeek, horizontalPadding: horizontalPadding)
                    VStack(alignment: .leading, spacing: 0) {
                        if page.isRow || page.props.isTemplate == true, let db = model.store.database(ofRow: pageID) {
                            RowPropertiesPanel(db: db, row: page, locked: editor.isLocked || db.locked == true)
                                .padding(.bottom, 12)
                        }
                        if format?.hideBacklinks != true { BacklinksView(pageID: pageID) }
                        if page.type == .databasePage {
                            DatabaseBlockView(blockID: pageID, fullPage: true)
                        } else {
                            BlockList(parentID: pageID, editor: editor, lazyWhenLong: true)
                            Color.clear
                                .frame(height: 160)
                                .frame(maxWidth: .infinity)
                                .contentShape(Rectangle())
                                .onTapGesture { if !editor.isLocked { editor.selectedBlocks = []; editor.focusEndOfPage() } }
                        }
                    }
                    .padding(.horizontal, horizontalPadding)
                    #if os(macOS)
                    // One hover region + overlay for the whole page: the + / ⋮⋮ of the block under the
                    // pointer, the blue drop line and the drag ghost (BlockGutter.swift). The padding is part
                    // of the region, so moving onto the handle keeps it visible.
                    .overlay(alignment: .topLeading) { BlockGutterOverlay(editor: editor) }
                    .onContinuousHover(coordinateSpace: BlockCanvas.space) { editor.gutter.hover($0, locked: editor.isLocked) }
                    .blockMarquee(editor)
                    .coordinateSpace(BlockCanvas.space)
                    .background(EnclosingScrollViewReader { editor.gutter.scrollView = $0 })
                    #endif
                }
                .frame(maxWidth: fullWidth ? .infinity : Theme.contentWidth + 2 * horizontalPadding, alignment: .leading)
                .frame(maxWidth: .infinity)
                }
            }
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { availableWidth = g.size.width }
                    .onChange(of: g.size.width) { _, w in availableWidth = w }
            })
            .overlay(alignment: .topTrailing) {
                if page.type != .databasePage, format?.hideOutline != true, !model.showFind {
                    PageOutline(pageID: pageID, scroll: scroll, topInset: page.props.cover != nil ? (isPeek ? 190 : 300) : 96)
                }
            }
            .onChange(of: editor.scrollRequest) { _, id in
                // Keyboard / programmatic focus on a block that isn't rendered yet (lazy long pages).
                guard let id else { return }
                editor.scrollRequest = nil
                guard let top = model.store.topLevelAncestor(of: id, in: pageID) else { return }
                withAnimation(.easeOut(duration: 0.12)) { scroll.scrollTo(top, anchor: .center) }
            }
            .onChange(of: model.findTarget) { _, target in
                // ⌘F: scroll the current match into view and mark it.
                guard !isPeek, let target, model.store.containingPage(of: target) == pageID else { return }
                withAnimation(.easeOut(duration: 0.15)) { scroll.scrollTo(target, anchor: .center) }
                editor.selectedBlocks = [target]
            }
            }
            #if os(macOS)
            .overlay {
                GeometryReader { geo in
                    if let sel = editor.selectionRect, editor.menu == nil, editor.aiPrompt == nil, !editor.isLocked {
                        let g = geo.frame(in: .global)
                        let x = min(max(8, sel.rect.minX - g.minX - 8), max(8, geo.size.width - 430))
                        let y = sel.rect.minY - g.minY - 46
                        FormatToolbar(editor: editor, blockID: sel.blockID)
                            .offset(x: x, y: y < 4 ? sel.rect.maxY - g.minY + 8 : y)
                            .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                    }
                }
                .animation(.easeOut(duration: 0.12), value: editor.selectionRect != nil)
            }
            .onReceive(NotificationCenter.default.publisher(for: NSView.boundsDidChangeNotification)) { n in
                // The toolbar follows its selection while the page scrolls.
                guard let sel = editor.selectionRect, let clip = editor.gutter.scrollView?.contentView,
                      (n.object as? NSView) === clip else { return }
                editor.host(sel.blockID)?.reportSelection()
            }
            #endif
            .acceptsFileDrops { model.dropFiles($0, onto: pageID) }
            .background(Color.clear.contentShape(Rectangle()).onTapGesture { editor.selectedBlocks = [] })
            .overlayPreferenceValue(MenuAnchorKey.self) { anchor in
                GeometryReader { geo in
                    if let anchor, let line = editor.aiPrompt {
                        let r = geo[anchor]
                        InlineAIBox(editor: editor, blockID: line)
                            .frame(width: min(640, max(320, geo.size.width - r.minX - 40)))
                            .offset(x: max(0, r.minX - 4), y: r.minY - 6)
                            .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
                    } else if let anchor, editor.menu != nil {
                        let r = geo[anchor]
                        // Notion: below the line whenever there's reasonable room, otherwise above; the height
                        // shrinks to the room on that side (it used to flip up early and cover the text).
                        let spaceBelow = geo.size.height - r.maxY - 12
                        let spaceAbove = r.minY - 12
                        let below = spaceBelow >= 160 || spaceBelow >= spaceAbove
                        let room = below ? spaceBelow : spaceAbove
                        let h = min(max(120, room), 360)
                        InlineMenuView(editor: editor, maxHeight: room)
                            .accessibilityIdentifier("slash.menu")
                            .frame(height: h, alignment: below ? .top : .bottom)
                            .offset(x: min(max(0, r.minX + 24), max(0, geo.size.width - 330)),
                                    y: below ? r.maxY + 4 : r.minY - 4 - h)
                            .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: below ? .top : .bottom)))
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
            #if os(macOS)
            selectionKeys.install(editor)
            #endif
            #if DEBUG
            Log.notice("PageScreen appear \(pageID.prefix(8)) peek \(isPeek) editor \(ObjectIdentifier(editor).hashValue)", category: "debug")
            #endif
        }
        .onChange(of: page.props.format) { _, f in editor.format = f }
        .onDisappear {
            #if os(macOS)
            selectionKeys.remove()
            #endif
            #if DEBUG
            Log.notice("PageScreen disappear \(pageID.prefix(8)) editor \(ObjectIdentifier(editor).hashValue)", category: "debug")
            #endif
            if model.activeEditor === editor { model.activeEditor = nil }
        }
    }

    private var horizontalPadding: CGFloat {
        #if os(macOS)
        // Never narrower than the + / ⋮⋮ gutter (it lives in this padding).
        if isPeek { return max(52, min(64, (availableWidth - Theme.contentWidth) / 2)) }
        return max(56, min(96, (availableWidth - Theme.contentWidth) / 2))
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
    /// Same horizontal padding as the block column, so title and blocks share one left edge.
    var horizontalPadding: CGFloat = 96
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var iconPicker = false

    private var store: WorkspaceStore { model.store }
    private var locked: Bool { editor.isLocked }
    private var hasCover: Bool { page.props.cover != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !hasCover {
                // Notion: ~80 pt of air above the title on a page without a cover (less in peek).
                Color.clear.frame(height: isPeek ? 28 : 64)
            }
            VStack(alignment: .leading, spacing: 4) {
                if let icon = page.props.icon {
                    Button { if !locked { iconPicker = true } } label: {
                        icon.view(size: 78, assets: model.assets).frame(width: 84, height: 84, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .help(locked ? "" : "Change icon")
                    // With a cover the icon overlaps its bottom edge by half, like Notion.
                    .offset(y: hasCover ? -42 : 0)
                    .padding(.bottom, hasCover ? -42 : 0)
                    .popover(isPresented: $iconPicker) {
                        IconPicker(current: page.props.icon) { store.setPageIcon(page.id, $0); iconPicker = false }
                    }
                } else if hasCover {
                    Color.clear.frame(height: 12)
                }
                if !locked {
                    HStack(spacing: 2) {
                        if page.props.icon == nil {
                            HeaderGhostButton(title: "Add icon", symbol: "face.smiling") {
                                store.setPageIcon(page.id, .emoji(EmojiCatalog.random()))
                            }
                        }
                        if !hasCover {
                            HeaderGhostButton(title: "Add cover", symbol: "photo") {
                                store.setPageCover(page.id, .gradient(Int.random(in: 0..<Covers.gradients.count)))
                            }
                        }
                    }
                    .padding(.leading, -6)
                    .opacity(hover ? 1 : 0)
                    .animation(.easeOut(duration: 0.12), value: hover)
                    .frame(height: 28)
                }
                title
                    .padding(.bottom, 8)
            }
            .padding(.horizontal, horizontalPadding)
        }
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

/// Notion's quiet header buttons ("Add icon", "Add cover"): grey text, light hover fill.
struct HeaderGhostButton: View {
    let title: String
    let symbol: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.system(size: 14))
                .foregroundStyle(Theme.secondary)
                .padding(.horizontal, 6).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 4).fill(hover ? Theme.hoverFill : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Full-bleed page cover with Notion's hover controls ("Change cover · Reposition · Remove").
struct PageCoverView: View {
    let page: Block
    let cover: PageCover
    var locked = false
    var isPeek = false
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var picker = false

    var body: some View {
        CoverView(cover: cover)
            .frame(maxWidth: .infinity)
            .frame(height: isPeek ? 160 : 260)
            .clipped()
            .overlay(alignment: .bottomTrailing) {
                if !locked {
                    HStack(spacing: 0) {
                        coverButton("Change cover") { picker = true }
                        Divider().frame(height: 14)
                        coverButton("Remove") { model.store.setPageCover(page.id, nil) }
                    }
                    .background(RoundedRectangle(cornerRadius: 4).fill(.regularMaterial))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.dividerColor))
                    .padding(.trailing, 16).padding(.bottom, 12)
                    .opacity(hover || picker ? 1 : 0)
                    .animation(.easeOut(duration: 0.12), value: hover)
                }
            }
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .popover(isPresented: $picker) {
                CoverPicker(current: page.props.cover) { model.store.setPageCover(page.id, $0); picker = false }
            }
    }

    private func coverButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.primary.opacity(0.75))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            if !model.store.containsProtected(pageID) {
                Button("Delete from Trash", role: .destructive) {
                    model.deleteForever([pageID])
                    model.goBack()
                }
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
            Button(model.isHome(page.id) ? "Home page" : "Set as Home page", systemImage: "house") { model.setHome(page.id) }
                .disabled(model.isHome(page.id))
            if !store.containsProtected(page.id) {
                Button("Delete", systemImage: "trash", role: .destructive) { model.trash(page.id) }
            }
            Divider()
            Button("Undo", systemImage: "arrow.uturn.backward") { model.undo() }.disabled(!store.canUndo)
            Button("Export as Markdown…", systemImage: "square.and.arrow.up") { model.exportRequest = AppModel.ExportRequest(pageID: page.id) }
            Button("Export as HTML…", systemImage: "chevron.left.forwardslash.chevron.right") { model.exportRequest = AppModel.ExportRequest(pageID: page.id, format: .html) }
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
