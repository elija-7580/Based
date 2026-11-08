import SwiftUI
import BasedCore
import BasedBrain

// MARK: - Sidebar

/// Notion-style sidebar: search, Home / Chat / Agents / Inbox / Agent Brain, Favorites, Private pages,
/// recent chats. Supports multi-selection (⌘-click / ⇧-click) with bulk actions in the context menu.
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier

    var body: some View {
        // Only structural changes (pages added / moved / renamed / trashed, favorites) re-render the sidebar.
        let _ = model.registry.workspace.structureRevision
        let store = model.store
        let brainRoot = model.brain.brain.rootID
        List(selection: selectionBinding) {
            Section {
                SearchFieldButton()
                Label("Home", systemImage: "house").tag(SidebarItem.home).accessibilityIdentifier("sidebar.home")
                Label("Chat", systemImage: "bubble.left").tag(SidebarItem.chat(nil)).accessibilityIdentifier("sidebar.askAI")
                Label("Agents", systemImage: "square.grid.2x2").tag(SidebarItem.projects).accessibilityIdentifier("sidebar.sessions")
                HStack {
                    Label("Inbox", systemImage: "tray")
                    Spacer()
                    if happier.pendingCount > 0 {
                        Text("\(happier.pendingCount)").font(.caption2.bold()).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(Color.orange))
                    }
                }
                .tag(SidebarItem.inbox)
                .accessibilityIdentifier("sidebar.inbox")
                Label("Agent Brain", systemImage: "brain").tag(SidebarItem.brain).accessibilityIdentifier("sidebar.brain")
            } header: {
                WorkspaceHeader()
            }
            let favorites = store.favoritePages()
            if !favorites.isEmpty {
                Section("Favorites") {
                    ForEach(favorites, id: \.id) { PageTreeRow(page: $0) }
                }
            }
            ForEach(store.teamspaces, id: \.id) { t in
                Section(t.name) {
                    ForEach(store.topLevelPages(in: .teamspace(t.id)), id: \.id) { PageTreeRow(page: $0) }
                }
            }
            Section("Private") {
                ForEach(store.topLevelPages(in: .privatePages).filter { $0.id != brainRoot }, id: \.id) { PageTreeRow(page: $0) }
                    .onMove { from, to in movePages(from: from, to: to) }
                Button { model.newPage() } label: { Label("Add a page", systemImage: "plus") }
                    .buttonStyle(.hoverFill).accessibilityIdentifier("sidebar.addPage")
                    .foregroundStyle(Theme.secondary)
            }
            let chats = happier.chats
            Section("Chats") {
                ForEach(chats.prefix(8)) { c in
                    Label { Text(c.title.isEmpty ? "New chat" : c.title).lineLimit(1) } icon: { Image(systemName: "bubble.left") }
                        .tag(SidebarItem.chat(c.id))
                }
                Button { model.openChat(nil, fullPage: true) } label: { Label("New chat", systemImage: "square.and.pencil") }
                    .buttonStyle(.plain).foregroundStyle(Theme.secondary)
                if chats.count > 8 {
                    Button { model.selection = .projects } label: { Label("View all", systemImage: "ellipsis") }
                        .buttonStyle(.plain).foregroundStyle(Theme.secondary)
                }
            }
            Section {
                Menu {
                    Button("Page", systemImage: "doc") { model.newPage() }
                    Button("Chat", systemImage: "bubble.left") { model.openChat(nil, fullPage: true) }
                    Button("Database (table)", systemImage: "tablecells") { newDatabase(.table) }
                    Button("Database (board)", systemImage: "rectangle.split.3x1") { newDatabase(.board) }
                    Button("Database (calendar)", systemImage: "calendar") { newDatabase(.calendar) }
                } label: { Label("New", systemImage: "square.and.pencil") }
                .menuStyle(.borderlessButton)
                .fixedSize()
                Menu {
                    Button("From Notion (API)…", systemImage: "square.and.arrow.down.on.square") { model.showNotionImport = true }
                    Button("From file (Notion export, Markdown, CSV, HTML)…", systemImage: "doc.zipper") { model.showImport = true }
                } label: { Label("Import", systemImage: "square.and.arrow.down") }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityIdentifier("sidebar.import")
                Label("Graph", systemImage: "point.3.connected.trianglepath.dotted").tag(SidebarItem.graph).accessibilityIdentifier("sidebar.graph")
                Label("Library", systemImage: "books.vertical").tag(SidebarItem.library).accessibilityIdentifier("sidebar.library")
                Label("Trash", systemImage: "trash").tag(SidebarItem.trash).accessibilityIdentifier("sidebar.trash")
                #if os(iOS)
                Label("Settings", systemImage: "gearshape").tag(SidebarItem.settings).accessibilityIdentifier("sidebar.settings")
                #endif
            }
        }
        .listStyle(.sidebar)
        .scrollIndicators(.never)
        .accessibilityIdentifier("sidebar")
        .contextMenu(forSelectionType: SidebarItem.self) { items in
            SidebarContextMenu(items: Array(items))
        }
        #if os(macOS)
        .onDeleteCommand { deleteSelectedPages() }
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.showCommandPalette = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityIdentifier("toolbar.newPage")
                    .help("New… (⌘N)")
            }
        }
        #if os(iOS)
        .navigationTitle(store.workspace.name)
        #endif
    }

    /// Multi-select binding: one item navigates, several items only select (for bulk actions).
    private var selectionBinding: Binding<Set<SidebarItem>> {
        Binding(get: { model.sidebarSelection }, set: { new in
            model.sidebarSelection = new
            guard new.count == 1, let item = new.first else { return }
            if case .chat(let id) = item { model.openChat(id, fullPage: true); return }
            if model.selection != item || !model.path.isEmpty {
                model.peek = nil
                model.selection = item
                model.path = []
            }
        })
    }

    private func deleteSelectedPages() {
        let ids = model.selectedPageIDs
        guard !ids.isEmpty else { return }
        model.trash(ids)
    }

    private func newDatabase(_ type: ViewType) {
        let c = model.store.createDatabase(in: .workspace, inline: false, viewType: type)
        model.openRoot(c.blockID)
    }

    private func movePages(from: IndexSet, to: Int) {
        let brainRoot = model.brain.brain.rootID
        let pages = model.store.topLevelPages(in: .privatePages).filter { $0.id != brainRoot }
        let ids = from.map { pages[$0].id }
        model.store.movePages(ids, to: .privateTop, at: to >= pages.count ? .end : .before(pages[to].id))
    }
}

/// Context menu for one or many selected sidebar items (right-click or the row's "…" button).
/// `scope` is the row's section scope ("fav:" for Favorites) so Rename edits the row that was clicked.
struct SidebarContextMenu: View {
    let items: [SidebarItem]
    var scope = ""
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.store
        let pages = items.compactMap { item -> RecordID? in if case .page(let id) = item { return id }; return nil }
        let chats = items.compactMap { item -> RecordID? in if case .chat(let id?) = item { return id }; return nil }
        if pages.count == 1, let id = pages.first, let page = store.blocks[id] {
            Button(store.isFavorite(id) ? "Remove from Favorites" : "Add to Favorites",
                   systemImage: store.isFavorite(id) ? "star.slash" : "star") { model.toggleFavorite([id]) }
            Divider()
            Button("Duplicate", systemImage: "plus.square.on.square") { model.duplicate([id]) }
            Button("Rename", systemImage: "pencil") { model.renamingID = scope + id }
            Button("Move to…", systemImage: "arrow.turn.up.right") { model.moveRequest = AppModel.MoveRequest(ids: [id]) }
            Divider()
            Button("Copy link", systemImage: "link") { Clipboard.copyLinks([id], store: model.store) }
            Button("Open in new tab", systemImage: "plus.rectangle.on.rectangle") { model.openInNewTab(id) }
            Button("Open in side peek", systemImage: "sidebar.right") { model.open(id, mode: .sidePeek) }
            if page.type == .page {
                Button("Add a page inside", systemImage: "plus") { model.newPage(in: .block(id)) }
            }
            Button("Export as Markdown…", systemImage: "square.and.arrow.up") { model.exportRequest = AppModel.ExportRequest(pageID: id) }
            Button("Export as HTML…", systemImage: "chevron.left.forwardslash.chevron.right") { model.exportRequest = AppModel.ExportRequest(pageID: id, format: .html) }
            Button(model.isHome(id) ? "Home page" : "Set as Home page", systemImage: "house") { model.setHome(id) }
                .disabled(model.isHome(id))
            if !store.containsProtected(id) {
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) { model.trash([id]) }
            }
        } else if pages.count > 1 {
            Text("\(pages.count) pages selected")
            Button(pages.allSatisfy { store.isFavorite($0) } ? "Remove from Favorites" : "Add to Favorites", systemImage: "star") { model.toggleFavorite(pages) }
            Button("Duplicate", systemImage: "plus.square.on.square") { model.duplicate(pages) }
            Button("Move to…", systemImage: "arrow.turn.up.right") { model.moveRequest = AppModel.MoveRequest(ids: pages) }
            Button("Open in new tabs", systemImage: "plus.rectangle.on.rectangle") { for id in pages { model.openInNewTab(id, activate: false) } }
            Divider()
            Button("Delete \(pages.count) pages", systemImage: "trash", role: .destructive) { model.trash(pages) }
        }
        if !chats.isEmpty {
            if chats.count == 1, let id = chats.first {
                Button("Open in side panel", systemImage: "sidebar.right") { model.openChat(id, fullPage: false) }
                Button("Open in new tab", systemImage: "plus.rectangle.on.rectangle") { model.newTab(.chat(id)) }
            }
            Button(chats.count == 1 ? "Delete chat" : "Delete \(chats.count) chats", systemImage: "trash", role: .destructive) {
                for id in chats { model.brain.happier.deleteSession(id) }
            }
        }
    }
}

/// "Search or ask ⌘K" field at the top of the sidebar.
struct SearchFieldButton: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Button { model.showQuickFind = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                Text("Search or ask")
                Spacer(minLength: 4)
                Text("⌘K").font(.system(size: 11)).padding(.horizontal, 5).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.08)))
            }
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.05)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.hoverFill)
        .accessibilityIdentifier("sidebar.search")
    }
}

struct WorkspaceHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let w = model.store.workspace
        HStack(spacing: 8) {
            Text(String(w.name.prefix(1)).uppercased())
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 22, height: 22)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.1)))
            Text(w.name).font(.system(size: 14, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 4)
            if model.syncStatus != "Off" && model.syncStatus != "Not configured" {
                Text(model.syncStatus).font(.caption2).foregroundStyle(Theme.secondary).lineLimit(1)
            }
        }
        .textCase(nil)
        .foregroundStyle(Theme.primary)
    }
}

/// One page in the sidebar tree, with lazily expanded sub-pages. Observes only its own block node
/// (title, icon, children), so typing elsewhere doesn't re-render the tree.
struct PageTreeRow: View {
    let page: Block
    @Environment(AppModel.self) private var model
    @State private var targeted = false
    @State private var hover = false

    var body: some View {
        let node = model.registry.block(page.id)
        let _ = node.children
        let current = node.block ?? page
        let store = model.store
        let subs = store.subpages(of: page.id)
        if subs.isEmpty {
            label(current, hasChildren: false)
        } else {
            DisclosureGroup(isExpanded: expanded) {
                if model.expanded.contains(page.id) {
                    ForEach(subs, id: \.id) { PageTreeRow(page: $0) }
                }
            } label: {
                label(current, hasChildren: true)
            }
        }
    }

    private var expanded: Binding<Bool> {
        Binding(get: { model.expanded.contains(page.id) },
                set: { if $0 { model.expanded.insert(page.id) } else { model.expanded.remove(page.id) } })
    }

    private func label(_ page: Block, hasChildren: Bool) -> some View {
        let store = model.store
        let isDB = page.type == .databasePage || page.type == .databaseInline
        if isDB, let db = page.props.databaseID { let _ = model.registry.database(db).revision }
        return HStack(spacing: 6) {
            PageIconView(icon: page.props.icon, isDatabase: isDB, size: 16)
            Text(store.title(of: page.id).nonEmptyOr("Untitled")).lineLimit(1)
            Spacer(minLength: 0)
            if hover, page.type == .page {
                Button { model.newPage(in: .block(page.id)) } label: { Image(systemName: "plus") }
                    .buttonStyle(.quiet)
                    .foregroundStyle(Theme.secondary)
                    .help("Add a page inside")
            }
        }
        .contentShape(Rectangle())
        .tag(SidebarItem.page(page.id))
        .onHover { hover = $0 }
        .background(RoundedRectangle(cornerRadius: 4).stroke(Theme.accentBlue, lineWidth: targeted ? 2 : 0))
        .onDrag {
            let selected = model.selectedPageIDs
            model.draggedBlocks = selected.contains(page.id) ? selected : [page.id]
            return NSItemProvider(object: page.id as NSString)
        }
        .onDrop(of: [.text], isTargeted: $targeted) { _ in
            let ids = model.draggedBlocks.filter { $0 != page.id && !store.isDescendant(page.id, of: $0) }
            model.draggedBlocks = []
            guard !ids.isEmpty, page.type == .page else { return false }
            if ids.allSatisfy({ store.blocks[$0]?.type.isPageLike == true }) {
                store.movePages(ids, to: .page(page.id))
            } else {
                store.moveBlocks(ids, to: .block(page.id), at: .end)
            }
            model.expanded.insert(page.id)
            return true
        }
    }
}
