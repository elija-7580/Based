import SwiftUI
#if os(macOS)
import AppKit
#endif
import Observation
import BasedCore

enum Peek: Identifiable, Equatable {
    case side(RecordID)
    case center(RecordID)
    var id: RecordID { switch self { case .side(let i), .center(let i): return i } }
}

struct NavSnapshot: Equatable {
    var selection: SidebarItem?
    var path: [RecordID]
}

enum SidebarItem: Hashable {
    case page(RecordID)
    case trash
    case settings
    case home
    case sessions   // Happier-style coding-agent sessions
    case inbox      // approvals / questions from agents
    case brain      // Agent Brain dashboard (About / Memories / Skills / Agents / Connections)
    case projects   // overview of all agent sessions grouped by project (+ Claude/Codex CLI history)
    case chat(RecordID?)   // full-page AI chat (nil = new chat)
    case diagnostics       // logs, hangs, layout audit

    /// Short label for tabs, breadcrumbs and logs.
    @MainActor func title(in model: AppModel) -> String {
        switch self {
        case .page(let id): return model.store.title(of: id).nonEmptyOr("Untitled")
        case .trash: return "Trash"
        case .settings: return "Settings"
        case .home: return "Home"
        case .sessions: return "Sessions"
        case .inbox: return "Inbox"
        case .brain: return "Agent Brain"
        case .projects: return "Agents"
        case .chat(let id): return id.map { model.store.title(of: $0).nonEmptyOr("Chat") } ?? "New chat"
        case .diagnostics: return "Diagnostics"
        }
    }

    var symbol: String {
        switch self {
        case .page: return "doc.text"
        case .trash: return "trash"
        case .settings: return "gearshape"
        case .home: return "house"
        case .sessions: return "terminal"
        case .inbox: return "tray"
        case .brain: return "brain"
        case .projects: return "square.grid.2x2"
        case .chat: return "bubble.left"
        case .diagnostics: return "stethoscope"
        }
    }

    var isPage: Bool { if case .page = self { return true }; return false }
}

/// One browser-style tab (⌘T). The active tab's state lives in `AppModel.selection/path/history`;
/// inactive tabs keep a snapshot here.
struct BrowserTab: Identifiable, Equatable {
    let id: UUID
    var selection: SidebarItem?
    var path: [RecordID]
    var back: [NavSnapshot] = []
    var forward: [NavSnapshot] = []

    init(id: UUID = UUID(), selection: SidebarItem?, path: [RecordID] = []) {
        self.id = id; self.selection = selection; self.path = path
    }

    var current: SidebarItem? {
        if let last = path.last { return .page(last) }
        return selection
    }
}

@MainActor @Observable
final class AppModel {
    let store: WorkspaceStore
    let assets: FileAssetStore
    @ObservationIgnored let registry: Registry
    /// Memoised view queries (filters/sorts/groups) — one shared cache, invalidated by store revision.
    @ObservationIgnored let queryCache: QueryCache
    @ObservationIgnored private(set) var persistence: SQLitePersistence?
    #if canImport(CloudKit)
    @ObservationIgnored private(set) var cloud: CloudSync?
    #endif

    // Navigation
    var selection: SidebarItem? = .home {
        didSet {
            if oldValue != selection { path = [] }
            noteNavigation()
            if let s = selection, !restoringHistory, sidebarSelection != [s] { sidebarSelection = [s] }
        }
    }
    var path: [RecordID] = [] { didSet { noteNavigation() } }
    /// Sidebar multi-selection (⌘/⇧-click); a single item also drives `selection`.
    var sidebarSelection: Set<SidebarItem> = [.home]
    /// Last plain / ⌘-clicked sidebar row (start of a ⇧-click range).
    @ObservationIgnored var sidebarAnchor: SidebarItem?
    /// macOS: sidebar hidden (⌘\); hovering the left edge peeks it in.
    var sidebarCollapsed = UserDefaults.standard.bool(forKey: "sidebarCollapsed") {
        didSet { UserDefaults.standard.set(sidebarCollapsed, forKey: "sidebarCollapsed") }
    }
    /// Browser-style tabs; `activeTabID` is the tab whose state is live in `selection` / `path`.
    var tabs: [BrowserTab] = []
    var activeTabID = UUID()
    /// Back / forward history across sidebar roots and the navigation stack (⌘[ / ⌘]).
    private(set) var backHistory: [NavSnapshot] = []
    private(set) var forwardHistory: [NavSnapshot] = []
    @ObservationIgnored private var lastSnapshot = NavSnapshot(selection: .home, path: [])
    @ObservationIgnored private var restoringHistory = false
    var peek: Peek?
    /// ⌘K / ⌘P search overlay.
    var showQuickFind = false
    /// Notion-style AI chat docked on the right (⌘J); `chatID` is the conversation shown there.
    var showChatPanel = false
    /// ⌘N command palette (new page / chat / meeting note / database).
    var showCommandPalette = false
    /// ⌘F find bar for the current page.
    var showFind = false
    var findQuery = ""
    var findIndex = 0
    var showSettings = false
    /// Agent Brain (memories, skills, agents, AI providers, server sync).
    @ObservationIgnored private(set) var brain: BrainModel!
    var showTrash = false
    var showImport = false
    /// Notion API import sheet (token + links).
    var showNotionImport = false
    var showExportAll = false
    var exportAllMessage: String?
    var exportRequest: ExportRequest?
    var moveRequest: MoveRequest?
    var expanded: Set<RecordID> = []
    var errorMessage: String?
    var syncStatus = "Off"
    var lastSyncDate: Date?
    /// Editor of the page that last had keyboard focus (menu commands are routed there).
    @ObservationIgnored weak var activeEditor: EditorController?
    #if os(macOS)
    /// The main window (⌘W closes tabs there, other windows close normally).
    @ObservationIgnored weak var mainWindow: NSWindow?
    #endif
    /// Blocks/pages being dragged inside the app (drop targets read this instead of decoding providers).
    @ObservationIgnored var draggedBlocks: [RecordID] = []

    struct ExportRequest: Identifiable {
        let id = UUID()
        var pageID: RecordID
    }

    struct MoveRequest: Identifiable {
        let id = UUID()
        var ids: [RecordID]
    }

    /// The item shown in the active tab (highlighted in the sidebar).
    var currentSidebarItem: SidebarItem? { path.last.map { SidebarItem.page($0) } ?? selection }

    func toggleSidebar() { sidebarCollapsed.toggle() }

    var currentPageID: RecordID? {
        if let last = path.last { return last }
        if case .page(let id)? = selection { return id }
        return nil
    }

    /// Window title: the page / screen shown in the active tab.
    var currentTitle: String { (path.last.map { SidebarItem.page($0) } ?? selection)?.title(in: self) ?? "Based" }

    /// "Parent / Grandparent" path of the current page (window subtitle, Notion-style breadcrumb).
    var currentBreadcrumb: String {
        guard let id = currentPageID else { return "" }
        return store.ancestors(of: id).filter { $0.type.isPageLike }.reversed()
            .map { store.title(of: $0.id).nonEmptyOr("Untitled") }.joined(separator: " / ")
    }

    /// ⌘F on a full-page database focuses its search field instead of the page find bar.
    var dbSearchRequest = 0
    /// Rows of the database a peek was opened from (peek ↑ / ↓ buttons).
    var peekSiblings: [RecordID] = []
    /// Block the find bar jumped to (pages scroll to it).
    var findTarget: RecordID?
    /// Bumped by ⌘F while the find bar is already open (refocuses its field).
    var findFocusRequest = 0

    init(inMemory: Bool = false) {
        // Before anything touches Application Support: move data out of the old sandbox container
        // (builds ≤ Pass 8 were sandboxed) and start the log file.
        AppDiagnostics.bootstrap()
        // Keychain reads happen in the background, without UI (they used to block launch on a permission prompt).
        Secrets.startLoading()
        let openStart = Date()
        let fm = FileManager.default
        let base = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("Based", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        assets = FileAssetStore(root: dir.appendingPathComponent("Assets", isDirectory: true))
        var p: SQLitePersistence?
        if !inMemory {
            do { p = try SQLitePersistence(url: dir.appendingPathComponent("based.sqlite")) } catch { errorMessage = "\(error)" }
        }
        persistence = p
        let node = Self.deviceNodeID()
        store = WorkspaceStore(persistence: p ?? (try? SQLitePersistence(url: nil)), node: node)
        registry = Registry(store: store)
        queryCache = QueryCache(store: store)
        if store.blocks.isEmpty { Onboarding.seed(store) }
        let storeMS = Int(Date().timeIntervalSince(openStart) * 1000)
        let brainStart = Date()
        brain = BrainModel(store: store)
        let brainMS = Int(Date().timeIntervalSince(brainStart) * 1000)
        brain.assets = assets
        if let first = store.topLevelPages().first(where: { $0.id != brain.brain.rootID }) { selection = .page(first.id) }
        tabs = [BrowserTab(id: activeTabID, selection: selection)]
        lastSnapshot = NavSnapshot(selection: selection, path: [])
        backHistory = []
        store.purgeTrash()
        startSyncIfConfigured()
        brain.happier.onSessionStarted = { [weak self] sid in self?.openSession(sid) }
        store.prepareLinkIndexInBackground()
        Log.info("Workspace opened: \(store.blocks.count) blocks, \(store.databases.count) databases in \(Int(Date().timeIntervalSince(openStart) * 1000)) ms (store \(storeMS) ms, agent brain \(brainMS) ms)", category: "app")
    }

    static func deviceNodeID() -> String {
        let key = "based.node"
        if let v = UserDefaults.standard.string(forKey: key) { return v }
        let v = String(UUID().uuidString.prefix(8)).lowercased()
        UserDefaults.standard.set(v, forKey: key)
        return v
    }

    // MARK: Sync

    /// iCloud is only used when the build has a container (signed builds with the iCloud entitlement).
    var cloudContainerID: String? {
        guard let id = Bundle.main.object(forInfoDictionaryKey: "BasedCloudKitContainer") as? String,
              !id.isEmpty, !id.contains("$(") else { return nil }
        return id
    }

    /// Set at build time via `BASED_CLOUD_SYNC` (Info.plist key `BasedCloudSyncEnabled`).
    static var cloudSyncBuildFlag: Bool {
        let v = Bundle.main.object(forInfoDictionaryKey: "BasedCloudSyncEnabled")
        if let b = v as? Bool { return b }
        if let s = v as? String { return ["yes", "true", "1"].contains(s.lowercased()) }
        return false
    }

    var syncEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "based.sync") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "based.sync"); newValue ? startSyncIfConfigured() : stopSync() }
    }

    func startSyncIfConfigured() {
        #if canImport(CloudKit)
        guard cloud == nil, syncEnabled, let id = cloudContainerID, Self.cloudSyncBuildFlag else {
            syncStatus = cloudContainerID == nil ? "Not configured" : "Off"
            return
        }
        let c = CloudSync(store: store, containerIdentifier: id, assets: assets)
        c.onStatus = { [weak self] s in self?.updateSyncStatus(s) }
        cloud = c
        c.start()
        syncStatus = "On"
        #else
        syncStatus = "Unavailable"
        #endif
    }

    func stopSync() {
        #if canImport(CloudKit)
        cloud?.stop()
        cloud = nil
        #endif
        syncStatus = "Off"
    }

    #if canImport(CloudKit)
    func updateSyncStatus(_ s: CloudSyncStatus) {
        switch s {
        case .disabled: syncStatus = "Off"
        case .noAccount: syncStatus = "No iCloud account"
        case .idle(let d): syncStatus = "Up to date"; if let d { lastSyncDate = d }
        case .syncing: syncStatus = "Syncing…"
        case .error(let m): syncStatus = "Error: \(m)"
        }
    }
    #endif

    func syncNow() {
        #if canImport(CloudKit)
        guard let cloud else { return }
        Task { await cloud.syncNow() }
        #endif
    }

    // MARK: Navigation

    /// Open a page: rows honour their database's "open pages in" setting unless forced.
    func open(_ id: RecordID, mode: OpenMode? = nil) {
        guard store.blocks[id] != nil else { return }
        let m = mode ?? .fullPage
        switch m {
        case .sidePeek: peek = .side(id)
        case .centerPeek: peek = .center(id)
        case .fullPage:
            peek = nil
            if case .page(let root)? = selection, root == id, path.isEmpty { return }
            if path.last == id { return }
            if selection?.isPage != true {
                selection = .page(id)
            } else {
                path.append(id)
            }
            for a in store.ancestors(of: id) { expanded.insert(a.id) }
        }
    }

    func openRoot(_ id: RecordID) {
        peek = nil
        selection = .page(id)
        path = []
    }

    @discardableResult
    func newPage(in parent: ParentRef = .workspace, open: Bool = true) -> RecordID {
        let id = store.createPage(in: parent)
        if case .block(let p) = parent { expanded.insert(p) }
        if open {
            if case .workspace = parent { openRoot(id) } else { self.open(id) }
        }
        return id
    }

    func trash(_ id: RecordID) {
        store.trash([id])
        if currentPageID == id || store.isTrashed(currentPageID ?? "") {
            if !path.isEmpty { path.removeAll { store.isTrashed($0) } }
            if case .page(let r)? = selection, store.isTrashed(r) {
                selection = store.topLevelPages().first.map { .page($0.id) } ?? .home
            }
        }
        if case .side(let p)? = peek, store.isTrashed(p) { peek = nil }
        if case .center(let p)? = peek, store.isTrashed(p) { peek = nil }
    }

    func setWorkspaceIcon(_ icon: PageIcon?) {
        store.transact("Workspace icon") { tx in tx.updateWorkspace { $0.icon = icon } }
    }

    /// Settings → Export all: every page as Markdown (databases as CSV + page folders) into one directory.
    func exportWorkspace(to directory: URL) {
        let exporter = MarkdownExporter(store: store)
        let fm = FileManager.default
        var count = 0
        func write(_ page: Block, into dir: URL) {
            let base = MarkdownExporter.fileName(store.title(of: page.id))
            let isDB = page.type == .databasePage || page.type == .databaseInline
            let text = isDB ? (store.database(forBlock: page.id).map { exporter.csv(database: $0.id) } ?? "") : exporter.export(page: page.id)
            try? text.write(to: dir.appendingPathComponent(base + (isDB ? ".csv" : ".md")), atomically: true, encoding: .utf8)
            count += 1
            let kids = store.subpages(of: page.id)
            if !kids.isEmpty {
                let sub = dir.appendingPathComponent(base, isDirectory: true)
                try? fm.createDirectory(at: sub, withIntermediateDirectories: true)
                kids.forEach { write($0, into: sub) }
            }
        }
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        store.topLevelPages().forEach { write($0, into: directory) }
        exportAllMessage = "Exported \(count) pages to \(directory.path)"
    }

    func exportCurrentPage() {
        guard let id = currentPageID ?? peek?.id else { return }
        exportRequest = ExportRequest(pageID: id)
    }

    /// ⌘⇧U — open the parent page of the current page.
    func openParent() {
        guard let id = currentPageID ?? peek?.id, let parent = store.containingPage(of: id) ?? store.parentBlock(of: id).flatMap({ store.containingPage(of: $0.id) }) else {
            selection = .home; return
        }
        open(parent)
    }

    var canGoBack: Bool { !backHistory.isEmpty || !path.isEmpty || peek != nil }
    var canGoForward: Bool { !forwardHistory.isEmpty }

    func goBack() {
        if peek != nil { peek = nil; return }
        guard let prev = backHistory.popLast() else {
            if !path.isEmpty { path.removeLast() }
            return
        }
        forwardHistory.append(lastSnapshot)
        restore(prev)
    }

    func goForward() {
        guard let next = forwardHistory.popLast() else { return }
        peek = nil
        backHistory.append(lastSnapshot)
        restore(next)
    }

    private func noteNavigation() {
        guard !restoringHistory else { return }
        let cur = NavSnapshot(selection: selection, path: path)
        guard cur != lastSnapshot else { return }
        Log.breadcrumb("navigate → \((path.last.map { SidebarItem.page($0) } ?? selection)?.title(in: self) ?? "nothing")")
        backHistory.append(lastSnapshot)
        if backHistory.count > 100 { backHistory.removeFirst() }
        forwardHistory.removeAll()
        lastSnapshot = cur
    }

    private func restore(_ s: NavSnapshot) {
        restoringHistory = true
        selection = s.selection
        path = s.path
        restoringHistory = false
        lastSnapshot = s
    }

    func undo() { store.undo() }
    func redo() { store.redo() }

    // MARK: Tabs (⌘T / ⌘W / ⌃Tab / ⌘1…9)

    var activeTabIndex: Int { tabs.firstIndex { $0.id == activeTabID } ?? 0 }

    /// Title + icon for a tab (the active tab reflects live navigation).
    func tabInfo(_ tab: BrowserTab) -> (title: String, item: SidebarItem?) {
        let item = tab.id == activeTabID ? (path.last.map { SidebarItem.page($0) } ?? selection) : tab.current
        return (item?.title(in: self) ?? "New tab", item)
    }

    private func stashActiveTab() {
        guard let i = tabs.firstIndex(where: { $0.id == activeTabID }) else { return }
        tabs[i].selection = selection
        tabs[i].path = path
        tabs[i].back = backHistory
        tabs[i].forward = forwardHistory
    }

    func selectTab(_ id: UUID) {
        guard id != activeTabID, let t = tabs.first(where: { $0.id == id }) else { return }
        stashActiveTab()
        activeTabID = id
        restoringHistory = true
        peek = nil
        selection = t.selection
        path = t.path
        backHistory = t.back
        forwardHistory = t.forward
        restoringHistory = false
        lastSnapshot = NavSnapshot(selection: selection, path: path)
        if let s = selection { sidebarSelection = [s] }
        Log.breadcrumb("tab → \(tabInfo(t).title)")
    }

    func newTab(_ item: SidebarItem? = .home, path newPath: [RecordID] = [], activate: Bool = true) {
        let t = BrowserTab(selection: item, path: newPath)
        let at = min(tabs.count, activeTabIndex + 1)
        tabs.insert(t, at: at)
        if activate { selectTab(t.id) }
    }

    func openInNewTab(_ id: RecordID, activate: Bool = true) {
        guard store.blocks[id] != nil else { return }
        newTab(.page(id), activate: activate)
    }

    func closeTab(_ id: UUID? = nil) {
        let target = id ?? activeTabID
        guard let i = tabs.firstIndex(where: { $0.id == target }) else { return }
        if tabs.count == 1 {
            // Closing the last tab resets it to Home (the window stays open, like Notion).
            restoringHistory = true
            selection = .home; path = []
            restoringHistory = false
            lastSnapshot = NavSnapshot(selection: .home, path: [])
            return
        }
        if target == activeTabID {
            let next = tabs[i == tabs.count - 1 ? i - 1 : i + 1].id
            selectTab(next)
        }
        tabs.removeAll { $0.id == target }
    }

    func cycleTab(_ delta: Int) {
        guard tabs.count > 1 else { return }
        let i = (activeTabIndex + delta + tabs.count) % tabs.count
        selectTab(tabs[i].id)
    }

    func selectTab(index: Int) {
        guard !tabs.isEmpty else { return }
        let i = index >= 8 ? tabs.count - 1 : min(index, tabs.count - 1)   // ⌘9 = last tab
        selectTab(tabs[i].id)
    }

    func moveTab(_ id: UUID, before other: UUID) {
        guard id != other, let from = tabs.firstIndex(where: { $0.id == id }) else { return }
        let t = tabs.remove(at: from)
        let to = tabs.firstIndex { $0.id == other } ?? tabs.count
        tabs.insert(t, at: to)
    }

    // MARK: Agent sessions

    /// Session shown in the Agents screen (`.sessions`).
    var agentSessionID: RecordID?
    /// ⌘N → "New agent session" sheet.
    var showNewSession = false
    /// Set before showing the sheet to start a sub-agent of this session.
    var newSessionParent: RecordID?

    enum AgentsMode: String, CaseIterable { case sessions = "Sessions", board = "Board", canvas = "Canvas" }
    /// Agents screen: session list + console, Kanban board, or the canvas of agents per project.
    var agentsMode: AgentsMode = AgentsMode(rawValue: UserDefaults.standard.string(forKey: "agents.mode") ?? "") ?? .sessions {
        didSet { UserDefaults.standard.set(agentsMode.rawValue, forKey: "agents.mode") }
    }

    func newSubAgent(of parent: RecordID) {
        newSessionParent = parent
        showNewSession = true
    }

    func openSession(_ sid: RecordID, console: Bool = true) {
        agentSessionID = sid
        if console { agentsMode = .sessions }
        peek = nil
        if selection != .sessions { selection = .sessions }
    }

    // MARK: Chats

    func openChat(_ id: RecordID?, fullPage: Bool) {
        brain.openChat(id)
        if fullPage {
            peek = nil
            showChatPanel = false
            selection = .chat(id)
        } else {
            if case .side? = peek { peek = nil }
            showChatPanel = true
        }
    }

    /// ⌘J: toggle the docked chat (closes a side peek that occupies the same space).
    func toggleChatPanel() {
        if showChatPanel { showChatPanel = false; return }
        if case .side? = peek { peek = nil }
        showChatPanel = true
    }

    // MARK: Bulk page actions (sidebar multi-select, database rows)

    var selectedPageIDs: [RecordID] {
        sidebarSelection.compactMap { if case .page(let id) = $0 { return id }; return nil }
    }

    func trash(_ ids: [RecordID]) {
        for id in ids { trash(id) }
        sidebarSelection = selection.map { [$0] } ?? []
    }

    func duplicate(_ ids: [RecordID]) { _ = store.duplicateBlocks(ids) }

    func toggleFavorite(_ ids: [RecordID]) {
        let allFav = ids.allSatisfy { store.isFavorite($0) }
        for id in ids where store.isFavorite(id) == allFav { store.toggleFavorite(id) }
    }
}

/// First-run content: a short tour of what the app can do.
enum Onboarding {
    @MainActor
    static func seed(_ store: WorkspaceStore) {
        let welcome = store.createPage(title: "Getting Started", icon: .emoji("👋"))
        let md = """
        👋 Welcome to **Based** — a native, local-first notes app with pages, blocks and databases.

        ## The basics
        - [ ] Click anywhere and just start typing
        - [ ] Hit `/` to see all the types of content you can add — headers, lists, toggles, code, databases …
        - [ ] Use Markdown shortcuts: `#` heading, `-` bullet, `[]` to-do, `>` toggle, `"` quote, `---` divider
        - [ ] Select text to **format** it, or use ⌘B / ⌘I / ⌘U / ⌘E / ⌘K
        - [ ] Press Tab / Shift-Tab to nest and un-nest blocks
        - [ ] Drag blocks by their ⋮⋮ handle to rearrange them
        - [ ] Type `[[` or `@` to link to another page

        ## Sync
        Your workspace syncs privately through your own iCloud account between Mac and iPhone.
        """
        store.insertImported(MarkdownImporter().parse(md), in: .block(welcome), name: "Welcome")
        let tasks = store.createDatabase(title: "Tasks", in: .block(welcome), inline: true, viewType: .table, sampleRows: 0)
        if let db = store.databases[tasks.databaseID] {
            let status = store.addProperty(to: db.id, name: "Status", type: .status)
            let due = store.addProperty(to: db.id, name: "Due", type: .date)
            let s = store.databases[db.id]?.property(status ?? "")
            let opts = s?.options ?? []
            store.addRow(to: db.id, title: "Try the slash menu", values: [status ?? "": .status(opts.first?.id ?? "")])
            store.addRow(to: db.id, title: "Create a board view", values: [status ?? "": .status(opts.dropFirst().first?.id ?? "")])
            store.addRow(to: db.id, title: "Import from Notion", values: [due ?? "": .date(DateValue(start: Date()))])
        }
        store.createPage(title: "Quick Note", icon: .emoji("📝"))
        let journal = store.createPage(title: "Journal", icon: .emoji("📔"))
        store.insertBlock(.text, text: "Write something…", in: .block(journal))
        store.clearUndoHistory()
    }
}