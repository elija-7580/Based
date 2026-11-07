import SwiftUI
import UniformTypeIdentifiers
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

/// Window content: sidebar + a detail shell (tabs, page / dashboard, find bar, right panel for side peek or AI chat)
/// and the global overlays (⌘K search, ⌘N command palette, import progress).
struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var importSummary: String?
    @State private var importProgress: Double?
    @State private var crash: CrashReporter.Info? = CrashReporter.pendingNotice

    var body: some View {
        @Bindable var model = model
        Group {
            #if os(macOS)
            MacShell()
            #else
            NavigationSplitView(columnVisibility: $columns) {
                SidebarView()
                    .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 400)
            } detail: {
                DetailShell()
            }
            #endif
        }
        .overlay {
            if model.showQuickFind {
                ModalBackdrop { model.showQuickFind = false } content: { SearchOverlay() }
            } else if model.showCommandPalette {
                ModalBackdrop { model.showCommandPalette = false } content: { CommandPalette() }
            }
        }
        .overlay {
            if let p = importProgress {
                ImportProgressCard(progress: p)
            }
        }
        .overlay(alignment: .bottom) { ToastHost() }
        .auditLayout("window")
        #if os(macOS)
        .background(WindowAccessor { model.mainWindow = $0; WindowChrome.configure($0) })
        .onAppear { NavigationInput.install(model: model) }
        #endif
        .sheet(isPresented: $model.showTrash) { TrashView(sheet: true).environment(model) }
        .sheet(isPresented: $model.showNewSession, onDismiss: { model.newSessionParent = nil }) {
            NewSessionSheet(parent: model.newSessionParent).environment(model.brain.happier)
        }
        .sheet(isPresented: $model.showExportAll) { ExportAllSheet().environment(model) }
        .sheet(isPresented: $model.showNotionImport) { NotionImportSheet().environment(model) }
        .sheet(item: $model.moveRequest) { req in
            MovePicker(ids: req.ids) { model.moveRequest = nil }.environment(model)
        }
        #if os(iOS)
        .sheet(isPresented: $model.showSettings) { NavigationStack { SettingsView() }.environment(model).environment(model.brain).environment(model.brain.happier) }
        #endif
        .fileImporter(isPresented: $model.showImport, allowedContentTypes: [.folder, .zip, .item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): importFiles(urls, into: .workspace)
            case .failure(let e): Log.error("import picker failed: \(e.localizedDescription)", category: "import")
            }
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
        .alert(crash?.hangSeconds != nil ? "Based froze last time" : "Based quit unexpectedly last time", isPresented: Binding(get: { crash != nil }, set: { if !$0 { crash = nil; CrashReporter.dismissPreviousCrash() } })) {
            Button("Copy report") { AppDiagnostics.copyReport(model: model); crash = nil; CrashReporter.dismissPreviousCrash() }
            Button("Show diagnostics") { model.selection = .diagnostics; crash = nil; CrashReporter.dismissPreviousCrash() }
            Button("Dismiss", role: .cancel) { crash = nil; CrashReporter.dismissPreviousCrash() }
        } message: { Text(crash?.summary ?? "") }
        .onChange(of: model.errorMessage) { _, m in if let m { Log.error("alert: \(m)", category: "ui") } }
        .onChange(of: model.pendingImport) { _, p in
            guard let p else { return }
            model.pendingImport = nil
            importFiles(p.urls, into: p.parent)
        }
        .onOpenURL { url in
            guard url.scheme == "based" else { return }
            #if DEBUG && os(macOS)
            if DebugDriver.handle(url, model: model) { return }
            #endif
            // based://page/<id> (also based://<id> and Notion-style ids) — the same link agents and other apps use.
            if let id = PageLink.id(from: url.absoluteString), model.store.blocks[id] != nil { model.open(id) }
        }
    }

    private var errorShown: Binding<Bool> {
        Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    }

    // MARK: Import / export

    /// Unzips / converts in the background (big Notion exports take seconds), then imports on the main actor.
    private func importFiles(_ urls: [URL], into parent: ParentRef) {
        // Lossless Based archives restore records directly (no conversion).
        if urls.count == 1 {
            let scoped = urls[0].startAccessingSecurityScopedResource()
            defer { if scoped { urls[0].stopAccessingSecurityScopedResource() } }
            if let summary = model.importArchiveIfPossible(urls[0]) { importSummary = summary; return }
        }
        let scoped = urls.map { $0.startAccessingSecurityScopedResource() }
        Log.notice("import: \(urls.map(\.lastPathComponent).joined(separator: ", "))", category: "import")
        importProgress = 0
        let store = model.store, assets = model.assets
        Task { @MainActor in
            defer {
                for (u, s) in zip(urls, scoped) where s { u.stopAccessingSecurityScopedResource() }
                importProgress = nil
            }
            do {
                // Unzipping and parsing HTML exports happens off the main actor; writing is one transaction.
                let prepared = try await Task.detached(priority: .userInitiated) {
                    try NotionImporter.prepare(urls, assets: assets) { p in Task { @MainActor in importProgress = p * 0.8 } }
                }.value
                defer { prepared.cleanup() }
                importProgress = 0.85
                await Task.yield()
                let r = try Log.measure("import", category: "import", warnAfter: 2) {
                    try NotionImporter(store: store, assets: assets).importPrepared(prepared, into: parent)
                }
                var s = "\(r.pages) pages, \(r.databases) databases, \(r.rows) rows, \(r.assets) files imported."
                var seenNotes = Set<String>()
                let notes = (prepared.notes + r.warnings).filter { seenNotes.insert($0).inserted }
                if !notes.isEmpty { s += "\n\n" + notes.prefix(10).joined(separator: "\n") }
                if notes.count > 10 { s += "\n… \(notes.count - 10) more (see Diagnostics → Log)" }
                for w in r.warnings { Log.warning(w, category: "import") }
                Log.notice("import done: \(r.pages) pages, \(r.databases) dbs, \(r.rows) rows", category: "import")
                if prepared.builder == nil, r.pages + r.databases > 0 {
                    s += "\n\nTip: Markdown & CSV exports lose colors, toggles, columns and views. For a 1:1 copy use File → Import from Notion… (API) or a Notion HTML export."
                }
                importSummary = s
                if r.pages + r.databases == 0 {
                    importSummary = "Nothing was imported.\n\nChoose a Notion export (.zip — HTML recommended, folder, Markdown/CSV or HTML files), or use File → Import from Notion… with an integration token." + (notes.isEmpty ? "" : "\n\n" + notes.prefix(6).joined(separator: "\n"))
                }
                if let first = r.rootIDs.first { model.openRoot(first) }
            } catch {
                Log.error("import failed: \(error)", category: "import")
                model.errorMessage = "Import failed: \(error.localizedDescription)"
            }
        }
    }

    private var exportShown: Binding<Bool> {
        Binding(get: { model.exportRequest != nil }, set: { if !$0 { model.exportRequest = nil } })
    }

    private var exportIsHTML: Bool { model.exportRequest?.format == .html }

    private var exportIsCSV: Bool {
        guard !exportIsHTML, let id = model.exportRequest?.pageID, let b = model.store.blocks[id] else { return false }
        return b.type == .databasePage || b.type == .databaseInline
    }

    private var exportType: UTType { exportIsHTML ? .html : exportIsCSV ? .commaSeparatedText : .plainText }

    private var exportName: String {
        guard let id = model.exportRequest?.pageID else { return "Untitled" }
        return MarkdownExporter.fileName(model.store.title(of: id)) + (exportIsHTML ? ".html" : exportIsCSV ? ".csv" : ".md")
    }

    private var exportDocument: TextDocument? {
        guard let id = model.exportRequest?.pageID else { return nil }
        if exportIsHTML { return TextDocument(text: HTMLExporter(store: model.store).export(page: id)) }
        let exporter = MarkdownExporter(store: model.store)
        if exportIsCSV, let db = model.store.database(forBlock: id) {
            return TextDocument(text: exporter.csv(database: db.id))
        }
        return TextDocument(text: exporter.export(page: id))
    }
}

#if os(macOS)
/// Reports the hosting NSWindow once the view is in a window.
struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { if let w = v.window { onWindow(w) } }
        return v
    }
    func updateNSView(_ v: NSView, context: Context) {
        if let w = v.window { DispatchQueue.main.async { onWindow(w) } }
    }
}
#endif

/// Dimmed backdrop for the ⌘K / ⌘N overlays: click outside or Esc closes.
struct ModalBackdrop<Content: View>: View {
    let dismiss: () -> Void
    @ViewBuilder let content: () -> Content
    /// Springs in like Notion's ⌘K / Claude's palette: a soft fade of the scrim and a slight scale-up.
    @State private var shown = false

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(shown ? 0.28 : 0)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: dismiss)
            content()
                .scaleEffect(shown ? 1 : 0.97, anchor: .top)
                .opacity(shown ? 1 : 0)
                .offset(y: shown ? 0 : -6)
                .background(RoundedRectangle(cornerRadius: 12).fill(.background).shadow(color: .black.opacity(0.22), radius: 24, y: 10))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(Theme.divider)))
                .padding(.top, 70)
                .padding(.horizontal, 24)
            Button("", action: dismiss).keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0)
        }
        .transition(.opacity.animation(.easeOut(duration: 0.12)))
        .onAppear { withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) { shown = true } }
    }
}

struct ImportProgressCard: View {
    let progress: Double
    var body: some View {
        VStack(spacing: 10) {
            ProgressView(value: min(1, max(0, progress))).frame(width: 240)
            Text(progress < 0.65 ? "Unpacking export…" : "Importing pages…").font(.callout).foregroundStyle(Theme.secondary)
        }
        .padding(20)
        .background(RoundedRectangle(cornerRadius: 12).fill(.regularMaterial))
        .accessibilityIdentifier("import.progress")
    }
}

// MARK: - Detail shell

/// Tab strip + content + right panel (side peek or docked AI chat). Content is keyed by the current item only,
/// so navigating swaps one flat view (no nested NavigationStack on macOS — that caused the shifted / clipped
/// layout and the toolbar jumping on open).
struct DetailShell: View {
    @Environment(AppModel.self) private var model
    @AppStorage("rightPanelWidth") private var panelWidth: Double = 420

    var body: some View {
        let _ = model.registry.workspace.structureRevision   // window title / breadcrumb follow renames
        #if os(macOS)
        GeometryReader { geo in
            // Docked panel next to the content when there's room (content keeps ≥ 380 pt); in narrow windows it
            // floats over the content instead of squeezing / clipping it.
            let docked = geo.size.width >= 380 + 300
            let maxPanel = docked ? max(300, geo.size.width - 380) : max(260, geo.size.width - 40)
            let width = min(max(docked ? 300 : 260, panelWidth), maxPanel)
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    DetailContent()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .overlay(alignment: .topTrailing) {
                            if model.showFind { FindBar().padding(.top, 8).padding(.trailing, 16) }
                        }
                }
                .frame(minWidth: docked ? 380 : 0, maxWidth: .infinity)
                .overlay { centerPeekOverlay(geo.size) }
                if docked, let panel = rightPanel {
                    PanelResizeHandle(width: $panelWidth, range: 300...maxPanel)
                    panel
                        .frame(width: width)
                        .frame(maxHeight: .infinity)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .overlay(alignment: .trailing) {
                if !docked, let panel = rightPanel {
                    panel
                        .frame(width: width)
                        .frame(maxHeight: .infinity)
                        .shadow(color: .black.opacity(0.2), radius: 12, x: -4)
                        .transition(.move(edge: .trailing))
                }
            }
            .animation(.spring(response: 0.32, dampingFraction: 0.9), value: panelKey)
        }
        .navigationTitle(model.currentTitle)
        #else
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            DetailContent(rootOnly: true)
                .navigationDestination(for: RecordID.self) { id in PageScreen(pageID: id, model: model).id(id) }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { HistoryButtons(size: 15) }
                    ToolbarItem(placement: .primaryAction) {
                        Button { model.toggleChatPanel() } label: { AIGlyph(size: 18) }
                            .accessibilityIdentifier("toolbar.chat")
                    }
                }
        }
        .overlay(alignment: .top) { if model.showFind { FindBar().padding(.top, 8) } }
        .sheet(item: peekBinding) { p in
            PeekView(pageID: p.id, mode: .centerPeek).environment(model)
        }
        .sheet(isPresented: $model.showChatPanel) {
            ChatPanel().environment(model).environment(model.brain).environment(model.brain.happier)
                .presentationDetents([.medium, .large])
        }
        #endif
    }

    private var panelKey: String {
        if case .side(let id)? = model.peek { return "peek-" + id }
        return model.showChatPanel ? "chat" : "none"
    }

    private var rightPanel: AnyView? {
        if case .side(let id)? = model.peek {
            return AnyView(PeekView(pageID: id, mode: .sidePeek).id(id).accessibilityIdentifier("peek.side"))
        }
        if model.showChatPanel { return AnyView(ChatPanel().accessibilityIdentifier("chat.panel")) }
        return nil
    }

    @ViewBuilder
    private func centerPeekOverlay(_ size: CGSize) -> some View {
        if case .center(let id)? = model.peek {
            ZStack {
                Color.black.opacity(0.2).contentShape(Rectangle()).onTapGesture { model.peek = nil }
                PeekView(pageID: id, mode: .centerPeek).id(id)
                    .frame(width: min(960, max(360, size.width - 80)), height: max(300, size.height - 70))
                    .background(RoundedRectangle(cornerRadius: 10).fill(.background).shadow(color: .black.opacity(0.25), radius: 20, y: 8))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("peek.center")
                Button("") { model.peek = nil }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0)
            }
            .transition(.opacity)
        }
    }

    #if os(iOS)
    private var peekBinding: Binding<Peek?> {
        Binding(get: { model.peek }, set: { v in if v == nil { model.peek = nil } })
    }
    #endif
}

/// The current item's screen. On macOS everything (including sub-pages) renders here; on iOS sub-pages are
/// pushed onto the NavigationStack, so `rootOnly` shows the sidebar selection.
struct DetailContent: View {
    var rootOnly = false
    @Environment(AppModel.self) private var model

    var body: some View {
        let item: SidebarItem = (rootOnly ? nil : model.path.last.map { SidebarItem.page($0) }) ?? model.selection ?? .home
        #if os(macOS)
        VStack(spacing: 0) {
            if !item.isPage && !(item == .home && model.homePageID != nil) { ScreenTopBar(item: item) }
            content(item)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .id(key(item))
        .auditLayout("content")
        #else
        content(item)
            .id(key(item))
            .auditLayout("content")
        #endif
    }

    /// Chats share one key so "New chat" → saved chat doesn't rebuild the screen mid-conversation.
    private func key(_ item: SidebarItem) -> String {
        switch item {
        case .chat: return "chat"
        case .sessions, .projects: return "agents"
        case .page(let id): return "page-" + id
        case .home: return "home-" + (model.homePageID ?? "")
        default: return "\(item)"
        }
    }

    @ViewBuilder
    private func content(_ item: SidebarItem) -> some View {
        switch item {
        case .page(let id): PageScreen(pageID: id, model: model)
        case .home:
            if let h = model.homePageID { PageScreen(pageID: h, model: model) } else { HomeChooser() }
        case .trash: TrashView()
        case .settings: SettingsView()
        case .sessions, .projects: AgentsScreen()
        case .inbox: InboxView()
        case .brain: BrainDashboard()
        case .chat: ChatFullPage()
        case .diagnostics: DiagnosticsView()
        case .library: LibraryView()
        }
    }
}

/// 1-pt divider with an 8-pt drag area that resizes the right panel.
struct PanelResizeHandle: View {
    @Binding var width: Double
    let range: ClosedRange<Double>
    @State private var start: Double?

    var body: some View {
        Rectangle()
            .fill(Color(Theme.divider))
            .frame(width: 1)
            .overlay {
                Color.clear
                    .frame(width: 9)
                    .contentShape(Rectangle())
                    #if os(macOS)
                    .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
                    #endif
                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { v in
                            if start == nil { start = min(max(width, range.lowerBound), range.upperBound) }
                            width = min(max(range.lowerBound, (start ?? width) - v.translation.width), range.upperBound)
                        }
                        .onEnded { _ in start = nil })
            }
            .accessibilityIdentifier("panel.resize")
    }
}

/// Plain text file for `.fileExporter` (Markdown / CSV).
struct TextDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText, .commaSeparatedText, .html] }
    var text: String

    init(text: String) { self.text = text }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

// MARK: - Home

/// Home without a chosen page: pick one (any page can be Home — set it here, from a page's ••• menu or from
/// the sidebar). The old Home overview (recents, favorites, get started) now sits at the top of Library.
struct HomeChooser: View {
    @Environment(AppModel.self) private var model
    @State private var filter = ""

    var body: some View {
        let _ = model.registry.workspace.structureRevision
        let store = model.store
        let recent = store.recentPages(limit: 8)
        let top = store.topLevelPages()
        let q = filter.trimmingCharacters(in: .whitespaces)
        let candidates = (recent + top.filter { t in !recent.contains { $0.id == t.id } })
            .filter { q.isEmpty || store.title(of: $0.id).localizedCaseInsensitiveContains(q) }
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "house").font(.system(size: 34)).foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity).padding(.top, 48)
                Text("Choose your Home page").font(.system(size: 26, weight: .bold)).frame(maxWidth: .infinity)
                Text("Home opens the page you pick. You can change it any time from a page's ••• menu or by right-clicking a page in the sidebar.")
                    .foregroundStyle(Theme.secondary).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                TextField("Filter pages…", text: $filter).textFieldStyle(.roundedBorder).frame(maxWidth: 420).frame(maxWidth: .infinity)
                VStack(spacing: 2) {
                    ForEach(candidates.prefix(40), id: \.id) { p in
                        Button { model.setHome(p.id) } label: {
                            HStack(spacing: 10) {
                                PageIconView(icon: p.props.icon, isDatabase: p.type == .databasePage, size: 16)
                                Text(store.title(of: p.id).nonEmptyOr("Untitled")).lineLimit(1)
                                Spacer()
                                Text("Set as Home").font(.caption).foregroundStyle(Color.accentColor)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("home.choose." + p.id)
                    }
                }
                .frame(maxWidth: 520).frame(maxWidth: .infinity)
                HStack(spacing: 10) {
                    Button("New page as Home") { let id = model.store.createPage(title: "Home", icon: .emoji("🏠")); model.setHome(id) }
                    Button("Open Library overview") { model.selection = .library }
                }
                .buttonStyle(.bordered).frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 40).padding(.bottom, 40)
        }
        .accessibilityIdentifier("home.chooser")
        #if os(iOS)
        .navigationTitle("Home")
        #endif
    }
}

/// Overview shown at the top of Library: greeting, recently visited, favorites, get started.
struct HomeOverview: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let _ = model.registry.workspace.structureRevision
        let store = model.store
        VStack(alignment: .leading, spacing: 18) {
            Text(greeting).font(.system(size: 22, weight: .bold))
            section("Recently visited", symbol: "clock") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(store.recentPages(limit: 12), id: \.id) { p in
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
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(favs, id: \.id) { p in
                                Button { model.open(p.id) } label: {
                                    HStack(spacing: 6) { PageIconView(icon: p.props.icon, size: 14); Text(store.title(of: p.id)).lineLimit(1) }
                                        .padding(.horizontal, 10).padding(.vertical, 6)
                                        .background(Capsule().fill(Color.primary.opacity(0.05)))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            HStack(spacing: 10) {
                Button("New page") { model.newPage() }
                Button("Search ⌘K") { model.showQuickFind = true }
                Button("Import from Notion…") { model.showNotionImport = true }
                if let h = model.homePageID {
                    Button("Home: \(store.title(of: h).nonEmptyOr("Untitled"))") { model.goHome() }
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .accessibilityIdentifier("library.overview")
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
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.secondary)
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

// MARK: - Trash


