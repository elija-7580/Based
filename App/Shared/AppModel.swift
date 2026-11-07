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
    case library           // every page / database / memory / skill / file, with bulk actions

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
        case .library: return "Library"
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
        case .library: return "books.vertical"
        }
    }

    var isPage: Bool { if case .page = self { return true }; return false }

    /// Which sidebar mode the item belongs to (AI: chats, agents, inbox, Agent Brain; Notes: everything else).
    var mode: SidebarMode {
        switch self {
        case .chat, .sessions, .projects, .inbox, .brain: return .ai
        default: return .notes
        }
    }
}

/// The sidebar's two worlds, each with its own Home: Notes (pages, your Home page, Library) and AI
/// (chat, chats, agents, inbox, Agent Brain — Home is a new chat).
enum SidebarMode: String, CaseIterable, Identifiable {
    case notes, ai
    var id: String { rawValue }
    var title: String { self == .notes ? "Notes" : "AI" }
    var symbol: String { self == .notes ? "doc.text" : SymbolImage.ai }
    var home: SidebarItem { self == .notes ? .home : .chat(nil) }
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
    /// Page text zoom (View → Zoom In/Out, ⌘+ / ⌘- / ⌘0). Pages rebuild their text at the new size.
    var pageZoom: Double = Double(Theme.zoom) {
        didSet {
            pageZoom = min(1.6, max(0.7, (pageZoom * 20).rounded() / 20))
            Theme.zoom = CGFloat(pageZoom)
            UserDefaults.standard.set(pageZoom, forKey: "pageZoom")
        }
    }
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
            // The sidebar follows navigation into the other world (e.g. ⌘J full page, a chat link, Inbox).
            if let s = selection, s != .settings, s != .diagnostics {
                if s.mode != sidebarMode { sidebarMode = s.mode }
                lastItem[s.mode.rawValue] = s
            }
            noteNavigation()
            if let s = selection, !restoringHistory, sidebarSelection != [s] { sidebarSelection = [s] }
        }
    }
    var path: [RecordID] = [] { didSet { noteNavigation() } }
    /// Notes / AI sidebar (persisted).
    var sidebarMode: SidebarMode = SidebarMode(rawValue: UserDefaults.standard.string(forKey: "sidebar.mode") ?? "") ?? .notes {
        didSet { UserDefaults.standard.set(sidebarMode.rawValue, forKey: "sidebar.mode") }
    }
    /// Last screen visited in each mode, so switching back returns there.
    @ObservationIgnored var lastItem: [String: SidebarItem] = [:]

    /// The switcher at the top of the sidebar: show that world and go to where you were in it (or its Home).
    func switchSidebar(to mode: SidebarMode) {
        guard mode != sidebarMode || selection?.mode != mode else { return }
        sidebarMode = mode
        let target = lastItem[mode.rawValue] ?? mode.home
        peek = nil
        if case .chat(let id) = target { openChat(id, fullPage: true) } else { selection = target }
    }

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
    /// The overlay was opened by a new tab (⌘T / "+"): picking a page fills that tab instead of opening another one.
    var quickFindForNewTab = false
    /// Notion-style AI chat docked on the right (⌘J); `chatID` is the conversation shown there.
    var showChatPanel = false
    /// Text to put into the chat composer (e.g. "Ask AI" on a selection quotes the selected text).
    var chatDraft: String?
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
    /// Sidebar rows whose sub-pages are shown; persisted so the tree reopens the way it was left.
    var expanded: Set<RecordID> = Set(UserDefaults.standard.stringArray(forKey: "sidebar.expanded") ?? []) {
        didSet {
            guard expanded != oldValue else { return }
            UserDefaults.standard.set(Array(expanded.prefix(4000)), forKey: "sidebar.expanded")
        }
    }
    /// Sidebar row (page id or teamspace id) currently showing an inline rename field.
    var renamingID: RecordID?
    /// Bottom toast ("Moved to Trash · Undo"); replaced by the next one, dismissed after a few seconds.
    var toast: Toast?
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
        enum Format { case markdown, html }
        let id = UUID()
        var pageID: RecordID
        var format: Format = .markdown
    }

    /// Documents dropped onto a page / the sidebar, waiting for RootView's import pipeline.
    struct PendingImport: Identifiable, Equatable {
        let id = UUID()
        var urls: [URL]
        var parent: ParentRef
    }
    var pendingImport: PendingImport?

    struct MoveRequest: Identifiable {
        let id = UUID()
        var ids: [RecordID]
    }

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        var message: String
        var actionTitle: String?
        /// Pages the action restores (Undo of a delete).
        var restoreIDs: [RecordID] = []
        static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
    }

    /// The item shown in the active tab (highlighted in the sidebar).
    var currentSidebarItem: SidebarItem? { path.last.map { SidebarItem.page($0) } ?? selection }

    func toggleSidebar() { sidebarCollapsed.toggle() }

    var currentPageID: RecordID? {
        if let last = path.last { return last }
        if case .page(let id)? = selection { return id }
        if selection == .home { return store.homePageID }
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
        var dir = base.appendingPathComponent("Based", isDirectory: true)
        #if DEBUG
        // Benchmarks run a second instance on a copy of the workspace (scripts/bench-*.sh).
        if let d = ProcessInfo.processInfo.environment["BASED_DATA_DIR"], !d.isEmpty { dir = URL(fileURLWithPath: d, isDirectory: true) }
        #endif
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
        #if os(macOS)
        // ⌘-click on any page link, row, card, mention or breadcrumb: open it in a new tab (⌘⇧: and switch to it).
        let intent = ClickIntent.newTab
        if intent.open { openInNewTab(id, activate: intent.activate); return }
        #endif
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
        #if os(macOS)
        let intent = ClickIntent.newTab
        if intent.open, store.blocks[id] != nil { openInNewTab(id, activate: intent.activate); return }
        #endif
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

    /// "+" on a sidebar section header / teamspace row: new top-level page in that section.
    @discardableResult
    func newTopLevelPage(in section: SidebarSectionID) -> RecordID {
        let id = store.createTopLevelPage(in: section)
        if case .teamspace(let t) = section { expanded.remove("teamspace.closed:" + t) }
        openRoot(id)
        return id
    }

    /// Moves a page (and everything inside it) to the Trash and offers Undo.
    func trash(_ id: RecordID) { trash([id]) }

    /// ⌘, and the workspace menu: Settings live inside the main window (no separate Settings window).
    func openSettings() {
        #if os(macOS)
        peek = nil
        selection = .settings
        #else
        showSettings = true
        #endif
    }

    // MARK: Home page

    /// The page shown under Home (nil → Home asks you to pick one; the overview lives in Library).
    var homePageID: RecordID? { store.homePageID }
    func isHome(_ id: RecordID) -> Bool { store.homePageID == id }

    func setHome(_ id: RecordID?) {
        store.setHomePage(id)
        if let id { showToast("“\(store.title(of: id).nonEmptyOr("Untitled"))” is now your Home page") }
        else { showToast("Home page cleared") }
    }

    /// Opens Home (⇧⌘H, sidebar row).
    func goHome() {
        peek = nil
        if selection == .home { path = [] } else { selection = .home }
    }

    /// Leaves trashed pages that are on screen (selection, navigation stack, peek).
    private func leaveTrashedPages() {
        if !path.isEmpty { path.removeAll { store.isTrashed($0) } }
        if case .page(let r)? = selection, store.isTrashed(r) {
            selection = store.topLevelPages().first.map { .page($0.id) } ?? .home
        }
        if case .side(let p)? = peek, store.isTrashed(p) { peek = nil }
        if case .center(let p)? = peek, store.isTrashed(p) { peek = nil }
        tabs = tabs.map { t in
            var t = t
            if case .page(let r)? = t.selection, store.isTrashed(r) { t.selection = .home; t.path = [] }
            t.path.removeAll { store.isTrashed($0) }
            return t
        }
    }

    func showToast(_ message: String, actionTitle: String? = nil, restoreIDs: [RecordID] = []) {
        let t = Toast(message: message, actionTitle: actionTitle, restoreIDs: restoreIDs)
        toast = t
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if self?.toast?.id == t.id { self?.toast = nil }
        }
    }

    /// Toast action: Undo of a delete restores exactly the pages it trashed (not whatever was edited last).
    func performToastAction() {
        guard let t = toast else { return }
        toast = nil
        if !t.restoreIDs.isEmpty { restore(t.restoreIDs, announce: false) }
    }

    func restore(_ ids: [RecordID], announce: Bool = true) {
        store.restorePages(ids)
        for id in ids { for a in store.ancestors(of: id) { expanded.insert(a.id) } }
        if announce { showToast(ids.count == 1 ? "Restored “\(store.title(of: ids[0]))”" : "Restored \(ids.count) pages") }
    }

    /// Trash → Delete permanently (the caller confirms first).
    func deleteForever(_ ids: [RecordID]) {
        let ids = ids.filter { !store.containsProtected($0) }
        let n = ids.count
        guard n > 0 else { brain.brain.repair(); return }
        store.deleteForever(ids)
        showToast(n == 1 ? "Deleted permanently" : "Deleted \(n) pages permanently")
    }

    func setWorkspaceIcon(_ icon: PageIcon?) {
        store.transact("Workspace icon") { tx in tx.updateWorkspace { $0.icon = icon } }
    }

    /// Settings → Export all: every page as Markdown (databases as CSV + page folders) into one directory.
    func exportWorkspace(to directory: URL, html: Bool = false) {
        let count = writeExport(store.topLevelPages(), to: directory, html: html)
        exportAllMessage = "Exported \(count) pages to \(directory.path)"
    }

    /// Writes pages as Markdown and databases as CSV, sub-pages in folders named after their parent.
    func writeExport(_ pages: [Block], to directory: URL, html: Bool = false) -> Int {
        let exporter = MarkdownExporter(store: store)
        let htmlExporter = HTMLExporter(store: store)
        let fm = FileManager.default
        var count = 0
        func write(_ page: Block, into dir: URL) {
            let base = MarkdownExporter.fileName(store.title(of: page.id))
            let isDB = page.type == .databasePage || page.type == .databaseInline
            let text = html ? htmlExporter.export(page: page.id)
                : isDB ? (store.database(forBlock: page.id).map { exporter.csv(database: $0.id) } ?? "") : exporter.export(page: page.id)
            try? text.write(to: dir.appendingPathComponent(base + (html ? ".html" : isDB ? ".csv" : ".md")), atomically: true, encoding: .utf8)
            count += 1
            let kids = store.subpages(of: page.id)
            if !kids.isEmpty {
                let sub = dir.appendingPathComponent(base, isDirectory: true)
                try? fm.createDirectory(at: sub, withIntermediateDirectories: true)
                kids.forEach { write($0, into: sub) }
            }
        }
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        pages.forEach { write($0, into: directory) }
        return count
    }

    func exportCurrentPage(as format: ExportRequest.Format = .markdown) {
        guard let id = currentPageID ?? peek?.id else { return }
        exportRequest = ExportRequest(pageID: id, format: format)
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

    /// Where back / forward lead, for the arrows' history menus: (offset, title), nearest first.
    struct HistoryEntry: Identifiable { let id: Int; let title: String }
    var backEntries: [HistoryEntry] {
        backHistory.reversed().prefix(12).enumerated().map { HistoryEntry(id: -($0.offset + 1), title: snapshotTitle($0.element)) }
    }
    var forwardEntries: [HistoryEntry] {
        forwardHistory.reversed().prefix(12).enumerated().map { HistoryEntry(id: $0.offset + 1, title: snapshotTitle($0.element)) }
    }

    private func snapshotTitle(_ s: NavSnapshot) -> String {
        (s.path.last.map { SidebarItem.page($0) } ?? s.selection)?.title(in: self) ?? "Home"
    }

    /// Several steps at once (history menu): negative = back, positive = forward.
    func jumpHistory(_ offset: Int) {
        if offset < 0 { for _ in 0..<(-offset) where !backHistory.isEmpty { goBack() } }
        else { for _ in 0..<offset where !forwardHistory.isEmpty { goForward() } }
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
        // A chat tab shows its own conversation (the chat screen is shared, so load it when the tab comes up).
        if case .chat(let cid?)? = selection, brain.chatID != cid { brain.openChat(cid) }
        Log.breadcrumb("tab → \(tabInfo(t).title)")
    }

    func newTab(_ item: SidebarItem? = .home, path newPath: [RecordID] = [], activate: Bool = true) {
        let t = BrowserTab(selection: item, path: newPath)
        let at = min(tabs.count, activeTabIndex + 1)
        tabs.insert(t, at: at)
        if activate { selectTab(t.id) }
    }

    /// ⌘T and "+": a new tab on Home with the ⌘K search on top (Home pinned as row 1, then recent pages / results).
    func newTabWithSearch() {
        newTab(.home)
        showCommandPalette = false
        quickFindForNewTab = true
        showQuickFind = true
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

    func moveTab(_ id: UUID, toIndex index: Int) {
        guard let from = tabs.firstIndex(where: { $0.id == id }), tabs.indices.contains(index), from != index else { return }
        let t = tabs.remove(at: from)
        tabs.insert(t, at: index)
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
    /// Lossless JSON Lines archive of the whole workspace (WorkspaceArchive).
    func exportArchive(to url: URL) {
        do {
            let data = try WorkspaceArchive.write(store)
            try data.write(to: url, options: .atomic)
            exportAllMessage = "Exported \(store.allRecords().count) records (\(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))) to \(url.lastPathComponent)."
            Log.notice("archive export: \(data.count) bytes", category: "import")
        } catch {
            exportAllMessage = "Export failed: \(error)"
        }
    }

    /// Imports a Based archive if `url` is one; returns nil when it isn't (other importers take over).
    func importArchiveIfPossible(_ url: URL) -> String? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        let head = h.readData(ofLength: 400); try? h.close()
        guard String(decoding: head, as: UTF8.self).contains("\"based-archive\"") else { return nil }
        do {
            let data = try Data(contentsOf: url)
            let r = try WorkspaceArchive.importArchive(data, into: store)
            var s = "\(r.imported) records imported from the Based archive."
            if r.keptNewer > 0 { s += " \(r.keptNewer) kept (newer here)." }
            if r.skipped > 0 { s += " \(r.skipped) unreadable lines skipped." }
            return s
        } catch {
            return "Import failed: \(error)"
        }
    }

    func toggleChatPanel() {
        if showChatPanel { showChatPanel = false; return }
        if case .side? = peek { peek = nil }
        showChatPanel = true
    }

    // MARK: Bulk page actions (sidebar multi-select, database rows)

    var selectedPageIDs: [RecordID] {
        sidebarSelection.compactMap { if case .page(let id) = $0 { return id }; return nil }
    }

    /// Moves pages to the Trash in one undoable step (children go with their parent) and shows an Undo toast.
    func trash(_ ids: [RecordID]) {
        let blocked = store.protectedAmong(ids)
        let done = store.trashPages(ids)
        if !blocked.isEmpty && done.isEmpty {
            showToast(blocked.count == 1 && ids.count == 1 ? "“\(store.title(of: blocked[0]).nonEmptyOr("Untitled"))” is part of the Agent Brain and can't be deleted"
                                                           : "Agent Brain pages can't be deleted")
            return
        }
        guard !done.isEmpty else { return }
        leaveTrashedPages()
        sidebarSelection = selection.map { [$0] } ?? []
        let title = done.count == 1 ? "“\(store.title(of: done[0]))” moved to Trash" : "\(done.count) pages moved to Trash"
        showToast(title, actionTitle: "Undo", restoreIDs: done)
    }

    func duplicate(_ ids: [RecordID]) {
        let copies = store.duplicatePages(ids)
        if !copies.isEmpty { showToast(copies.count == 1 ? "Duplicated" : "Duplicated \(copies.count) pages") }
    }

    func toggleFavorite(_ ids: [RecordID]) {
        let allFav = ids.allSatisfy { store.isFavorite($0) }
        store.setFavorite(ids, !allFav)
    }

    func move(_ ids: [RecordID], to destination: PageDestination) {
        store.movePages(ids, to: destination)
        if case .page(let p) = destination { expanded.insert(p); for a in store.ancestors(of: p) { expanded.insert(a.id) } }
        let where_: String
        switch destination {
        case .privateTop: where_ = "Private"
        case .teamspace(let t): where_ = store.teamspace(t)?.name ?? "Teamspace"
        case .page(let p): where_ = store.title(of: p)
        }
        showToast(ids.count == 1 ? "Moved to \(where_)" : "Moved \(ids.count) pages to \(where_)")
    }

    /// Markdown (pages) / CSV (databases) files for `ids` and their sub-pages, into `directory`.
    @discardableResult
    func exportPages(_ ids: [RecordID], to directory: URL) -> Int {
        let pages = ids.compactMap { store.blocks[$0] }
        let n = writeExport(pages, to: directory)
        showToast("Exported \(n) files to \(directory.lastPathComponent)")
        return n
    }

    #if os(macOS)
    /// Library → Export: choose a folder, then write the selection there.
    func exportPagesWithPanel(_ ids: [RecordID]) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Export"
        panel.message = "Choose a folder for \(ids.count) exported item\(ids.count == 1 ? "" : "s")"
        if panel.runModal() == .OK, let url = panel.url { exportPages(ids, to: url) }
    }
    #endif
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