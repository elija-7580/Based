import SwiftUI
import UniformTypeIdentifiers
import BasedCore

/// Window content: sidebar + page navigation stack + peeks and global sheets.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var importSummary: String?

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columns) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 380)
        } detail: {
            NavigationStack(path: $model.path) {
                detailRoot
                    .navigationDestination(for: RecordID.self) { id in
                        PageScreen(pageID: id, model: model).id(id)
                    }
            }
        }
        .inspector(isPresented: sidePeekShown) {
            if case .side(let id)? = model.peek {
                PeekView(pageID: id, mode: .sidePeek)
                    .inspectorColumnWidth(min: 360, ideal: 520, max: 900)
            }
        }
        .sheet(item: centerPeek) { peek in
            PeekView(pageID: peek.id, mode: .centerPeek).environment(model)
        }
        .sheet(isPresented: $model.showQuickFind) { QuickFindView().environment(model) }
        .sheet(isPresented: $model.showTrash) { TrashView(sheet: true).environment(model) }
        .sheet(item: $model.moveRequest) { req in
            PagePicker(purpose: .move(req.ids)) { model.moveRequest = nil }.environment(model)
        }
        #if os(iOS)
        .sheet(isPresented: $model.showSettings) { NavigationStack { SettingsView() }.environment(model) }
        #endif
        .fileImporter(isPresented: $model.showImport, allowedContentTypes: [.folder, .item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { importFiles(urls) }
        }
        .fileExporter(isPresented: exportShown, document: exportDocument, contentType: exportType,
                      defaultFilename: exportName) { result in
            if case .failure(let e) = result { model.errorMessage = e.localizedDescription }
            model.exportRequest = nil
        }
        .alert("Something went wrong", isPresented: errorShown) {
            Button("OK") { model.errorMessage = nil }
        } message: { Text(model.errorMessage ?? "") }
        .alert("Import finished", isPresented: Binding(get: { importSummary != nil }, set: { if !$0 { importSummary = nil } })) {
            Button("OK") { importSummary = nil }
        } message: { Text(importSummary ?? "") }
        .onOpenURL { url in
            guard url.scheme == "based" else { return }
            let id = url.lastPathComponent
            if url.host == "page" { model.open(id) }
        }
    }

    @ViewBuilder
    private var detailRoot: some View {
        switch model.selection {
        case .page(let id)?: PageScreen(pageID: id, model: model).id(id)
        case .trash?: TrashView()
        case .settings?: SettingsView()
        default: HomeView()
        }
    }

    // MARK: Peek bindings

    private var sidePeekShown: Binding<Bool> {
        Binding(get: { if case .side? = model.peek { return true }; return false },
                set: { if !$0, case .side? = model.peek { model.peek = nil } })
    }

    private var centerPeek: Binding<Peek?> {
        Binding(get: { if case .center? = model.peek { return model.peek }; return nil },
                set: { v in if v == nil, case .center? = model.peek { model.peek = nil } })
    }

    private var errorShown: Binding<Bool> {
        Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    }

    // MARK: Import / export

    private func importFiles(_ urls: [URL]) {
        let scoped = urls.map { $0.startAccessingSecurityScopedResource() }
        defer { for (u, s) in zip(urls, scoped) where s { u.stopAccessingSecurityScopedResource() } }
        do {
            let r = try NotionImporter(store: model.store, assets: model.assets).importItems(urls, into: .workspace)
            var s = "\(r.pages) pages, \(r.databases) databases, \(r.rows) rows, \(r.assets) files imported."
            if !r.warnings.isEmpty { s += "\n\n" + r.warnings.prefix(8).joined(separator: "\n") }
            importSummary = s
            if let first = r.rootIDs.first { model.openRoot(first) }
        } catch {
            model.errorMessage = "Import failed: \(error.localizedDescription)"
        }
    }

    private var exportShown: Binding<Bool> {
        Binding(get: { model.exportRequest != nil }, set: { if !$0 { model.exportRequest = nil } })
    }

    private var exportIsCSV: Bool {
        guard let id = model.exportRequest?.pageID, let b = model.store.blocks[id] else { return false }
        return b.type == .databasePage || b.type == .databaseInline
    }

    private var exportType: UTType { exportIsCSV ? .commaSeparatedText : .plainText }

    private var exportName: String {
        guard let id = model.exportRequest?.pageID else { return "Untitled" }
        return MarkdownExporter.fileName(model.store.title(of: id)) + (exportIsCSV ? ".csv" : ".md")
    }

    private var exportDocument: TextDocument? {
        guard let id = model.exportRequest?.pageID else { return nil }
        let exporter = MarkdownExporter(store: model.store)
        if exportIsCSV, let db = model.store.database(forBlock: id) {
            return TextDocument(text: exporter.csv(database: db.id))
        }
        return TextDocument(text: exporter.export(page: id))
    }
}

/// Plain text file for `.fileExporter` (Markdown / CSV).
struct TextDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText, .commaSeparatedText] }
    var text: String

    init(text: String) { self.text = text }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @State private var renaming = false

    var body: some View {
        @Bindable var model = model
        let _ = model.registry.workspace.revision
        let store = model.store
        List(selection: $model.selection) {
            Section {
                Button { model.showQuickFind = true } label: { Label("Search", systemImage: "magnifyingglass") }
                    .buttonStyle(.plain)
                Label("Home", systemImage: "house").tag(SidebarItem.home)
            } header: {
                WorkspaceHeader()
            }
            let favorites = store.favoritePages()
            if !favorites.isEmpty {
                Section("Favorites") {
                    ForEach(favorites, id: \.id) { PageTreeRow(page: $0) }
                }
            }
            Section("Private") {
                ForEach(store.topLevelPages(), id: \.id) { PageTreeRow(page: $0) }
                    .onMove { from, to in movePages(from: from, to: to) }
                Button { model.newPage() } label: { Label("Add a page", systemImage: "plus") }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.secondary)
            }
            Section {
                Menu {
                    Button("Page", systemImage: "doc") { model.newPage() }
                    Button("Database (table)", systemImage: "tablecells") { newDatabase(.table) }
                    Button("Database (board)", systemImage: "rectangle.split.3x1") { newDatabase(.board) }
                    Button("Database (calendar)", systemImage: "calendar") { newDatabase(.calendar) }
                } label: { Label("New", systemImage: "square.and.pencil") }
                .menuStyle(.borderlessButton)
                Button { model.showImport = true } label: { Label("Import", systemImage: "square.and.arrow.down") }
                    .buttonStyle(.plain)
                Label("Trash", systemImage: "trash").tag(SidebarItem.trash)
                #if os(iOS)
                Label("Settings", systemImage: "gearshape").tag(SidebarItem.settings)
                #endif
            }
        }
        .listStyle(.sidebar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.newPage() } label: { Image(systemName: "square.and.pencil") }
                    .help("New page")
            }
        }
        #if os(iOS)
        .navigationTitle(store.workspace.name)
        #endif
    }

    private func newDatabase(_ type: ViewType) {
        let c = model.store.createDatabase(in: .workspace, inline: false, viewType: type)
        model.openRoot(c.blockID)
    }

    private func movePages(from: IndexSet, to: Int) {
        let pages = model.store.topLevelPages()
        let ids = from.map { pages[$0].id }
        if to >= pages.count {
            model.store.moveBlocks(ids, to: .workspace, at: .end)
        } else {
            model.store.moveBlocks(ids, to: .workspace, at: .before(pages[to].id))
        }
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
            Spacer()
            Text(model.syncStatus).font(.caption2).foregroundStyle(Theme.secondary).lineLimit(1)
        }
        .textCase(nil)
        .foregroundStyle(Theme.primary)
    }
}

/// One page in the sidebar tree, with lazily expanded sub-pages.
struct PageTreeRow: View {
    let page: Block
    @Environment(AppModel.self) private var model
    @State private var targeted = false
    @State private var hover = false

    var body: some View {
        let store = model.store
        let subs = store.subpages(of: page.id)
        if subs.isEmpty {
            label(hasChildren: false)
        } else {
            DisclosureGroup(isExpanded: expanded) {
                ForEach(subs, id: \.id) { PageTreeRow(page: $0) }
            } label: {
                label(hasChildren: true)
            }
        }
    }

    private var expanded: Binding<Bool> {
        Binding(get: { model.expanded.contains(page.id) },
                set: { if $0 { model.expanded.insert(page.id) } else { model.expanded.remove(page.id) } })
    }

    private func label(hasChildren: Bool) -> some View {
        let store = model.store
        return HStack(spacing: 6) {
            PageIconView(icon: page.props.icon, isDatabase: page.type == .databasePage || page.type == .databaseInline, size: 16)
            Text(store.title(of: page.id)).lineLimit(1)
            Spacer(minLength: 0)
            if hover, page.type == .page {
                Button { model.newPage(in: .block(page.id)) } label: { Image(systemName: "plus") }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.secondary)
                    .help("Add a page inside")
            }
        }
        .contentShape(Rectangle())
        .tag(SidebarItem.page(page.id))
        .onHover { hover = $0 }
        .background(RoundedRectangle(cornerRadius: 4).stroke(Color.accentColor, lineWidth: targeted ? 2 : 0))
        .onDrag {
            model.draggedBlocks = [page.id]
            return NSItemProvider(object: page.id as NSString)
        }
        .onDrop(of: [.text], isTargeted: $targeted) { _ in
            let ids = model.draggedBlocks.filter { $0 != page.id && !store.isDescendant(page.id, of: $0) }
            model.draggedBlocks = []
            guard !ids.isEmpty, page.type == .page else { return false }
            if ids.allSatisfy({ store.blocks[$0]?.type.isPageLike == true }) {
                for id in ids { store.movePage(id, to: .block(page.id)) }
            } else {
                store.moveBlocks(ids, to: .block(page.id), at: .end)
            }
            model.expanded.insert(page.id)
            return true
        }
        .contextMenu {
            Button("Open", systemImage: "arrow.up.right.square") { model.openRoot(page.id) }
            Button("Open in side peek", systemImage: "sidebar.right") { model.open(page.id, mode: .sidePeek) }
            Divider()
            if page.type == .page {
                Button("Add a page inside", systemImage: "plus") { model.newPage(in: .block(page.id)) }
            }
            Button(store.isFavorite(page.id) ? "Remove from Favorites" : "Add to Favorites", systemImage: "star") {
                store.toggleFavorite(page.id)
            }
            Button("Duplicate", systemImage: "plus.square.on.square") { _ = store.duplicateBlocks([page.id]) }
            Button("Move to…", systemImage: "arrow.turn.up.right") { model.moveRequest = AppModel.MoveRequest(ids: [page.id]) }
            Button("Copy link", systemImage: "link") { Clipboard.copy("based://page/" + page.id) }
            Button("Export…", systemImage: "square.and.arrow.up") { model.exportRequest = AppModel.ExportRequest(pageID: page.id) }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) { model.trash(page.id) }
        }
    }
}

// MARK: - Home

struct HomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let _ = model.registry.workspace.revision
        let store = model.store
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text(greeting).font(.system(size: 30, weight: .bold)).frame(maxWidth: .infinity)
                    .padding(.top, 40)
                section("Recently visited", symbol: "clock") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(store.recentPages(limit: 12).filter { !$0.isRow || true }, id: \.id) { p in
                                Button { model.open(p.id) } label: { HomeCard(page: p) }.buttonStyle(.plain)
                            }
                            Button { model.newPage() } label: {
                                VStack { Image(systemName: "plus"); Text("New page") }
                                    .foregroundStyle(Theme.secondary)
                                    .frame(width: 150, height: 130)
                                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                let favs = store.favoritePages()
                if !favs.isEmpty {
                    section("Favorites", symbol: "star") {
                        ForEach(favs, id: \.id) { p in
                            Button { model.open(p.id) } label: {
                                HStack { PageIconView(icon: p.props.icon, size: 16); Text(store.title(of: p.id)); Spacer() }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                section("Get started", symbol: "sparkles") {
                    HStack(spacing: 10) {
                        Button("New page") { model.newPage() }
                        Button("Search ⌘P") { model.showQuickFind = true }
                        Button("Import from Notion…") { model.showImport = true }
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(.horizontal, 40)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Home")
    }

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        switch h {
        case 5..<12: return "Good morning"
        case 12..<18: return "Good afternoon"
        default: return "Good evening"
        }
    }

    private func section<C: View>(_ title: String, symbol: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondary)
            c()
        }
    }
}

struct HomeCard: View {
    let page: Block
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                if let c = page.props.cover { CoverView(cover: c) } else { Color.primary.opacity(0.05) }
                PageIconView(icon: page.props.icon, isDatabase: page.type == .databasePage, size: 26)
                    .padding(.leading, 12).offset(y: 12)
            }
            .frame(height: 50)
            .clipped()
            VStack(alignment: .leading, spacing: 4) {
                Text(model.store.title(of: page.id)).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                Spacer(minLength: 0)
                Text(page.updatedAt.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(Theme.secondary)
            }
            .padding(12)
            .padding(.top, 8)
        }
        .frame(width: 150, height: 130)
        .background(RoundedRectangle(cornerRadius: 12).fill(.background))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(Theme.divider)))
    }
}

// MARK: - Quick find

struct QuickFindView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var titleOnly = false
    @State private var sort: SearchSort = .bestMatch
    @State private var highlighted = 0
    @FocusState private var fieldFocused: Bool

    var body: some View {
        let hits = results
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.secondary)
                TextField("Search or jump to…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17))
                    .focused($fieldFocused)
                    .onSubmit { if highlighted < hits.count { open(hits[highlighted]) } }
                    .onKeyPress(.downArrow) { highlighted = min(hits.count - 1, highlighted + 1); return .handled }
                    .onKeyPress(.upArrow) { highlighted = max(0, highlighted - 1); return .handled }
            }
            .padding(14)
            HStack(spacing: 10) {
                Toggle("Title only", isOn: $titleOnly).toggleStyle(.button)
                Picker("Sort", selection: $sort) {
                    Text("Best match").tag(SearchSort.bestMatch)
                    Text("Last edited: newest").tag(SearchSort.lastEditedNewest)
                    Text("Last edited: oldest").tag(SearchSort.lastEditedOldest)
                    Text("Created: newest").tag(SearchSort.createdNewest)
                    Text("Created: oldest").tag(SearchSort.createdOldest)
                }
                .fixedSize()
                Spacer()
            }
            .font(.system(size: 12))
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if query.isEmpty { Text("Recent").font(.caption).foregroundStyle(Theme.secondary).padding(.horizontal, 14).padding(.top, 8) }
                        if hits.isEmpty, !query.isEmpty { Text("No results").foregroundStyle(Theme.secondary).padding(14) }
                        ForEach(Array(hits.enumerated()), id: \.element.pageID) { i, h in
                            Button { open(h) } label: { row(h, highlighted: i == highlighted) }
                                .buttonStyle(.plain)
                                .id(h.pageID)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onChange(of: highlighted) { _, i in if i < hits.count { proxy.scrollTo(hits[i].pageID) } }
            }
        }
        .frame(minWidth: 560, minHeight: 420)
        .onAppear { fieldFocused = true }
        .onChange(of: query) { _, _ in highlighted = 0 }
    }

    private var results: [SearchHit] {
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            return model.store.recentPages(limit: 15).map { SearchHit(pageID: $0.id, score: 0, snippet: nil, blockID: nil) }
        }
        var f = SearchFilters()
        f.titleOnly = titleOnly
        return SearchEngine(store: model.store).search(query, filters: f, sort: sort, limit: 50)
    }

    private func row(_ h: SearchHit, highlighted: Bool) -> some View {
        let store = model.store
        let path = store.ancestors(of: h.pageID).filter { $0.type.isPageLike }.reversed().map { store.title(of: $0.id) }
        return HStack(alignment: .top, spacing: 10) {
            PageIconView(icon: store.icon(of: h.pageID), isDatabase: store.blocks[h.pageID]?.type == .databasePage, size: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(store.title(of: h.pageID)).font(.system(size: 14, weight: .medium)).lineLimit(1)
                    if !path.isEmpty { Text("— " + path.joined(separator: " / ")).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1) }
                }
                if let s = h.snippet, !s.isEmpty { Text(s).font(.caption).foregroundStyle(Theme.secondary).lineLimit(2) }
            }
            Spacer()
            if let b = store.blocks[h.pageID] {
                Text(b.updatedAt.formatted(date: .abbreviated, time: .omitted)).font(.caption2).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .background(highlighted ? Color.primary.opacity(0.07) : Color.clear)
        .contentShape(Rectangle())
    }

    private func open(_ h: SearchHit) {
        dismiss()
        model.showQuickFind = false
        model.open(h.pageID)
    }
}

// MARK: - Trash

struct TrashView: View {
    var sheet = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var confirmEmpty = false

    var body: some View {
        let _ = model.registry.workspace.revision
        let store = model.store
        let items = store.trashedPages().filter { query.isEmpty || store.title(of: $0.id).localizedCaseInsensitiveContains(query) }
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Trash").font(.title2.bold())
                Spacer()
                if sheet { Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) }
            }
            TextField("Filter by page title…", text: $query).textFieldStyle(.roundedBorder)
            if items.isEmpty {
                ContentUnavailableView("Trash is empty", systemImage: "trash", description: Text("Pages in Trash are deleted after 30 days."))
            } else {
                List {
                    ForEach(items, id: \.id) { b in
                        HStack {
                            PageIconView(icon: b.props.icon, isDatabase: b.type == .databasePage, size: 16)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(store.title(of: b.id)).lineLimit(1)
                                if let t = b.trashedAt {
                                    Text("Deleted \(t.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(Theme.secondary)
                                }
                            }
                            Spacer()
                            Button { store.restore([b.id]) } label: { Image(systemName: "arrow.uturn.backward") }
                                .help("Restore")
                            Button(role: .destructive) { store.deleteForever([b.id]) } label: { Image(systemName: "trash") }
                                .help("Delete permanently")
                        }
                        .buttonStyle(.borderless)
                        .contentShape(Rectangle())
                        .onTapGesture { if sheet { dismiss() }; model.open(b.id) }
                    }
                }
                Button("Empty Trash", role: .destructive) { confirmEmpty = true }
                    .confirmationDialog("Permanently delete all pages in Trash?", isPresented: $confirmEmpty) {
                        Button("Delete all", role: .destructive) { store.emptyTrash() }
                    }
            }
        }
        .padding(16)
        .frame(minWidth: 420, minHeight: 420)
    }
}

// MARK: - Settings

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var syncOn = true
    @AppStorage(Appearance.key) private var appearance = Appearance.system.rawValue

    var body: some View {
        let store = model.store
        Form {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases) { a in Text(a.title).tag(a.rawValue) }
                }
            }
            Section("Workspace") {
                TextField("Name", text: $name)
                    .onSubmit { if !name.isEmpty { store.renameWorkspace(name) } }
                LabeledContent("Pages", value: "\(store.allPages().count)")
                LabeledContent("Databases", value: "\(store.databases.count)")
            }
            Section("iCloud sync") {
                LabeledContent("Status", value: model.syncStatus)
                if let d = model.lastSyncDate {
                    LabeledContent("Last synced", value: d.formatted(date: .abbreviated, time: .shortened))
                }
                Toggle("Sync with iCloud", isOn: Binding(get: { syncOn }, set: { v in syncOn = v; model.syncEnabled = v }))
                    .disabled(!AppModel.cloudSyncBuildFlag || model.cloudContainerID == nil)
                if !AppModel.cloudSyncBuildFlag || model.cloudContainerID == nil {
                    Text("This build has no iCloud container. Set BASED_CLOUD_SYNC = YES, a development team and an iCloud container in Config/Local.xcconfig, then rebuild.")
                        .font(.caption).foregroundStyle(Theme.secondary)
                }
                Button("Sync now") { model.syncNow() }.disabled(!syncOn)
            }
            Section("Data") {
                Button("Import from Notion export…") { model.showImport = true }
                Button("Purge Trash (older than 30 days)") { store.purgeTrash() }
                Button("Clear undo history") { store.clearUndoHistory() }
            }
            Section("About") {
                LabeledContent("Version", value: (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev")
                Text("Based is a local-first, open-source note-taking app. Data lives on this device and syncs through your private iCloud database.")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .onAppear { name = store.workspace.name; syncOn = model.syncEnabled }
    }
}
