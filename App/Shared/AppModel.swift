import SwiftUI
import Observation
import BasedCore

enum Peek: Identifiable, Equatable {
    case side(RecordID)
    case center(RecordID)
    var id: RecordID { switch self { case .side(let i), .center(let i): return i } }
}

enum SidebarItem: Hashable {
    case page(RecordID)
    case trash
    case settings
    case home
}

@MainActor @Observable
final class AppModel {
    let store: WorkspaceStore
    let assets: FileAssetStore
    @ObservationIgnored let registry: Registry
    @ObservationIgnored private(set) var persistence: SQLitePersistence?
    #if canImport(CloudKit)
    @ObservationIgnored private(set) var cloud: CloudSync?
    #endif

    // Navigation
    var selection: SidebarItem? = .home { didSet { if oldValue != selection { path = [] } } }
    var path: [RecordID] = []
    var peek: Peek?
    var showQuickFind = false
    var showSettings = false
    var showTrash = false
    var showImport = false
    var exportRequest: ExportRequest?
    var moveRequest: MoveRequest?
    var expanded: Set<RecordID> = []
    var errorMessage: String?
    var syncStatus = "Off"
    var lastSyncDate: Date?
    /// Editor of the page that last had keyboard focus (menu commands are routed there).
    @ObservationIgnored weak var activeEditor: EditorController?
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

    var currentPageID: RecordID? {
        if let last = path.last { return last }
        if case .page(let id)? = selection { return id }
        return nil
    }

    init(inMemory: Bool = false) {
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
        if store.blocks.isEmpty { Onboarding.seed(store) }
        if let first = store.topLevelPages().first { selection = .page(first.id) }
        store.purgeTrash()
        startSyncIfConfigured()
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
            if selection == nil || selection == .trash || selection == .settings || selection == .home {
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

    func exportCurrentPage() {
        guard let id = currentPageID ?? peek?.id else { return }
        exportRequest = ExportRequest(pageID: id)
    }

    func goBack() {
        if peek != nil { peek = nil; return }
        if !path.isEmpty { path.removeLast() }
    }

    func undo() { store.undo() }
    func redo() { store.redo() }
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