import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

/// Window chrome colours and metrics taken from Notion's desktop app (light / dark).
enum Chrome {
    static let titleBarHeight: CGFloat = 40
    /// Room for the traffic lights at the left of the title bar.
    static let trafficInset: CGFloat = 80
    static let topBarHeight: CGFloat = 44
    static let rowHeight: CGFloat = 28
    static let indentPerLevel: CGFloat = 12
    static let appBackground = Color(Theme.dynamic(light: 0xFFFFFF, dark: 0x191919))
    static let sidebarBackground = Color(Theme.dynamic(light: 0xF8F8F7, dark: 0x202020))
    static let titleBarBackground = Color(Theme.dynamic(light: 0xF2F1EE, dark: 0x1C1C1C))
    static let sidebarText = Color(Theme.dynamic(light: 0x5F5E5B, dark: 0x9B9B9B))
    static let sectionText = Color(Theme.dynamic(light: 0x91918E, dark: 0x7F7F7F))
    static let hover = Color(Theme.dynamic(light: 0xEFEFED, dark: 0x2C2C2C))
    static let selected = Color(Theme.dynamic(light: 0xEAEAE8, dark: 0x323232))
    static let accent = Color(Theme.dynamic(light: 0x2383E2, dark: 0x2383E2))
    static let border = Color(Theme.dynamic(light: 0xE9E9E7, dark: 0x2F2F2F))
}

/// Small borderless icon button used in the title bar, sidebar and page top bar (Notion's 28 pt hover squares).
/// 28 × 28 icon button with Notion's hover fill — for buttons that bring their own action (star, …).
struct ChromeHoverButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { HoverBody(configuration: configuration) }
    private struct HoverBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hover = false
        var body: some View {
            configuration.label
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Chrome.hover : .clear))
                .opacity(configuration.isPressed ? 0.7 : 1)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}

struct ChromeIconButton: View {
    let symbol: String
    var size: CGFloat = 15
    var help: String = ""
    var disabled = false
    var active = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            SymbolImage(name: symbol, size: size)
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 6).fill(hover && !disabled ? Chrome.hover : (active ? Chrome.selected : .clear)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(disabled ? Chrome.sidebarText.opacity(0.4) : Chrome.sidebarText)
        .disabled(disabled)
        .onHover { hover = $0 }
        .help(help)
    }
}

#if os(macOS)

// MARK: - Shell

/// macOS window layout like Notion's desktop app: a full-width title bar (traffic lights, sidebar toggle,
/// back / forward, tabs), a custom sidebar (resizable, collapsible with ⌘\, peeks in when hovering the left
/// edge while collapsed) and the detail shell.
struct MacShell: View {
    @Environment(AppModel.self) private var model
    @AppStorage("sidebarWidth") private var sidebarWidth: Double = 248
    @State private var peekSidebar = false

    var body: some View {
        let width = min(max(sidebarWidth, 200), 480)
        VStack(spacing: 0) {
            MacTitleBar(peekSidebar: $peekSidebar)
            Rectangle().fill(Chrome.border).frame(height: 1)
            HStack(spacing: 0) {
                if !model.sidebarCollapsed {
                    NotionSidebar()
                        .frame(width: width)
                        .transition(.move(edge: .leading))
                    SidebarResizeHandle(width: $sidebarWidth)
                }
                DetailShell()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Chrome.appBackground)
            }
            .overlay(alignment: .topLeading) { collapsedPeek(width) }
        }
        .background(Chrome.sidebarBackground)
        .ignoresSafeArea(.container, edges: .top)
        .animation(.easeOut(duration: 0.18), value: model.sidebarCollapsed)
        .animation(.easeOut(duration: 0.15), value: peekSidebar)
        .onChange(of: model.sidebarCollapsed) { _, collapsed in if !collapsed { peekSidebar = false } }
    }

    /// Collapsed sidebar: hovering the left edge (or the toggle button) slides a floating sidebar in.
    @ViewBuilder
    private func collapsedPeek(_ width: CGFloat) -> some View {
        if model.sidebarCollapsed {
            ZStack(alignment: .topLeading) {
                Color.clear
                    .frame(width: 8)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .onHover { if $0 { peekSidebar = true } }
                if peekSidebar {
                    NotionSidebar(floating: true)
                        .frame(width: width)
                        .frame(maxHeight: .infinity)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Chrome.sidebarBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Chrome.border))
                        .shadow(color: .black.opacity(0.16), radius: 16, x: 4, y: 6)
                        .padding(.top, 6).padding(.bottom, 12).padding(.leading, 6)
                        .onHover { if !$0 { peekSidebar = false } }
                        .transition(.move(edge: .leading).combined(with: .opacity))
                        .accessibilityIdentifier("sidebar.peek")
                }
            }
        }
    }
}

/// Title bar: traffic-light inset, sidebar toggle, back / forward, browser-style tabs. Empty space drags the
/// window (double-click zooms), like a native title bar.
struct MacTitleBar: View {
    @Binding var peekSidebar: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 2) {
            Color.clear.frame(width: Chrome.trafficInset, height: 1)
            ChromeIconButton(symbol: "sidebar.left", size: 15, help: model.sidebarCollapsed ? "Show sidebar (⌘\\)" : "Close sidebar (⌘\\)") {
                model.toggleSidebar()
            }
            .onHover { if $0 && model.sidebarCollapsed { peekSidebar = true } }
            .accessibilityIdentifier("toolbar.sidebar")
            HistoryButtons()
            TabStrip()
                .padding(.leading, 6)
            Spacer(minLength: 40)
        }
        .padding(.trailing, 8)
        .frame(height: Chrome.titleBarHeight)
        .frame(maxWidth: .infinity)
        .background(WindowDragArea())
        .background(Chrome.titleBarBackground)
    }
}

/// 1-pt divider with a wide invisible drag area that resizes the sidebar (Notion: 200…480 pt).
struct SidebarResizeHandle: View {
    @Binding var width: Double
    @State private var start: Double?
    @State private var hover = false

    var body: some View {
        Rectangle()
            .fill(hover || start != nil ? Chrome.accent.opacity(0.5) : Chrome.border)
            .frame(width: hover || start != nil ? 2 : 1)
            .overlay {
                Color.clear
                    .frame(width: 9)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        hover = inside
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { v in
                            if start == nil { start = width }
                            width = min(max(200, (start ?? width) + v.translation.width), 480)
                        }
                        .onEnded { _ in start = nil })
                    .onTapGesture(count: 2) { width = 248 }
            }
            .accessibilityIdentifier("sidebar.resize")
    }
}

/// Transparent NSView behind the title bar: drags the window and zooms / minimises on double-click
/// (honours the system "double-click a window's title bar" setting).
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 {
                let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
                if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
                return
            }
            window?.performDrag(with: event)
        }
    }
}

/// Hidden-title-bar window setup and traffic lights vertically centred in the 40 pt title bar.
@MainActor
enum WindowChrome {
    private static var configured = Set<ObjectIdentifier>()

    static func configure(_ w: NSWindow) {
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.styleMask.insert(.fullSizeContentView)
        positionTrafficLights(w)
        let key = ObjectIdentifier(w)
        guard !configured.contains(key) else { return }
        configured.insert(key)
        let names: [Notification.Name] = [NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification,
                                          NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
                                          NSWindow.didExitFullScreenNotification]
        for name in names {
            NotificationCenter.default.addObserver(forName: name, object: w, queue: .main) { [weak w] _ in
                MainActor.assumeIsolated { if let w { positionTrafficLights(w) } }
            }
        }
    }

    static func positionTrafficLights(_ w: NSWindow) {
        guard !w.styleMask.contains(.fullScreen) else { return }
        let types: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        for (i, t) in types.enumerated() {
            guard let b = w.standardWindowButton(t), let container = b.superview else { continue }
            let h = b.frame.height
            let y = container.isFlipped ? Chrome.titleBarHeight / 2 - h / 2
                                        : container.bounds.height - Chrome.titleBarHeight / 2 - h / 2
            b.setFrameOrigin(NSPoint(x: 16 + CGFloat(i) * 20, y: max(0, y)))
        }
    }
}

// MARK: - Sidebar

/// Click handling shared by sidebar rows: plain click navigates, ⌘-click toggles, ⇧-click selects a range.
@MainActor
enum SidebarClick {
    static func click(_ item: SidebarItem, model: AppModel, order: [SidebarItem]) {
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) {
            var s = model.sidebarSelection
            if let cur = model.currentSidebarItem, s.count <= 1 { s = [cur] }
            if s.contains(item) { s.remove(item) } else { s.insert(item) }
            model.sidebarSelection = s
            model.sidebarAnchor = item
            return
        }
        if flags.contains(.shift), let a = model.sidebarAnchor ?? model.currentSidebarItem,
           let i = order.firstIndex(of: a), let j = order.firstIndex(of: item) {
            model.sidebarSelection = Set(order[min(i, j)...max(i, j)])
            return
        }
        model.sidebarAnchor = item
        navigate(item, model: model)
    }

    static func navigate(_ item: SidebarItem, model: AppModel) {
        if case .chat(let id) = item { model.openChat(id, fullPage: true); return }
        model.peek = nil
        if model.selection != item || !model.path.isEmpty {
            model.selection = item
            model.path = []
        }
        model.sidebarSelection = [item]
    }

    static func isHighlighted(_ item: SidebarItem, model: AppModel) -> Bool {
        if model.sidebarSelection.count > 1 { return model.sidebarSelection.contains(item) }
        return model.currentSidebarItem == item
    }
}

/// Notion's sidebar: workspace switcher, search, Home / Chat / Agents / Inbox / Agent Brain, then the page
/// sections — Favorites, Teamspaces (one collapsible row per teamspace with its page tree), Private — and
/// Chats. Library, Trash and Settings stay pinned at the bottom. Rows: 28 pt, 14 pt text, 16 pt icons.
/// "Shared" is not shown: Based has no sharing model (single local user).
struct NotionSidebar: View {
    var floating = false
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    @AppStorage("sidebar.favoritesOpen") private var favoritesOpen = true
    @AppStorage("sidebar.teamspacesOpen") private var teamspacesOpen = true
    @AppStorage("sidebar.privateOpen") private var privateOpen = true
    @AppStorage("sidebar.chatsOpen") private var chatsOpen = true
    @FocusState private var focused: Bool
    @State private var privateDrop = false

    var body: some View {
        let _ = model.registry.workspace.structureRevision
        let store = model.store
        let brainRoot = model.brain.brain.rootID
        let favorites = store.favoritePages()
        let teamspaces = store.teamspaces
        let privatePages = store.topLevelPages(in: .privatePages).filter { $0.id != brainRoot }
        let dupes = Self.duplicateTitles(store.topLevelPages(), store: store)
        let order = visibleOrder(favorites: favorites, teamspaces: teamspaces, privatePages: privatePages)
        VStack(spacing: 0) {
            SidebarWorkspaceRow(floating: floating)
            SidebarModeSwitcher()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if model.sidebarMode == .notes {
                    SidebarSearchRow()
                    SidebarNavRow(item: .home, title: "Home", symbol: "house").accessibilityIdentifier("sidebar.home")

                    if !favorites.isEmpty {
                        SidebarSectionHeader(title: "Favorites", open: $favoritesOpen)
                        if favoritesOpen {
                            // Favorites list the page a second time on purpose (like Notion); the "fav:" scope keeps
                            // the two rows' identity, expansion and rename state apart.
                            ForEach(favorites, id: \.id) {
                                SidebarPageRow(page: $0, depth: 0, order: order, scope: "fav:", duplicateTitles: dupes).id("fav:" + $0.id)
                            }
                        }
                    }

                    SidebarSectionHeader(title: "Teamspaces", open: $teamspacesOpen, addHelp: "Create a teamspace") { createTeamspace() }
                    if teamspacesOpen {
                        ForEach(teamspaces, id: \.id) { t in
                            SidebarTeamspaceRow(teamspace: t, order: order, duplicateTitles: dupes).id("ts:" + t.id)
                        }
                        if teamspaces.isEmpty {
                            SidebarActionRow(title: "Create a teamspace", symbol: "plus") { createTeamspace() }
                                .accessibilityIdentifier("sidebar.addTeamspace")
                        }
                    }

                    SidebarSectionHeader(title: "Private", open: $privateOpen, addHelp: "Add a page", dropTargeted: privateDrop) {
                        model.newTopLevelPage(in: .privatePages)
                    }
                    .onDrop(of: [.text], delegate: SidebarSectionDropDelegate(destination: .privateTop, model: model, targeted: $privateDrop))
                    if privateOpen {
                        ForEach(privatePages, id: \.id) {
                            SidebarPageRow(page: $0, depth: 0, order: order, scope: "", duplicateTitles: dupes).id($0.id)
                        }
                        SidebarActionRow(title: "Add new", symbol: "plus") { model.newTopLevelPage(in: .privatePages) }
                            .accessibilityIdentifier("sidebar.addPage")
                    }

                    } else {
                    SidebarNavRow(item: .chat(nil), title: "New chat", symbol: SymbolImage.ai).accessibilityIdentifier("sidebar.askAI")
                    SidebarNavRow(item: .projects, title: "Agents", symbol: "square.grid.2x2").accessibilityIdentifier("sidebar.sessions")
                    SidebarNavRow(item: .inbox, title: "Inbox", symbol: "tray", badge: happier.pendingCount).accessibilityIdentifier("sidebar.inbox")
                    SidebarNavRow(item: .brain, title: "Agent Brain", symbol: "brain").accessibilityIdentifier("sidebar.brain")

                    SidebarSectionHeader(title: "Chats", open: $chatsOpen, addHelp: "New chat") { model.openChat(nil, fullPage: true) }
                    if chatsOpen {
                        ForEach(happier.chats.prefix(40)) { c in
                            SidebarNavRow(item: .chat(c.id), title: c.title.isEmpty ? "New chat" : c.title, symbol: "bubble.left", order: order)
                        }
                        if happier.chats.count > 40 {
                            SidebarActionRow(title: "View all", symbol: "ellipsis") { model.selection = .projects }
                        }
                    }
                }
                    }
                .padding(.horizontal, 8)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.never)
            .acceptsFileDrops { model.dropFilesOnWorkspace($0, intoOpenPage: false) }
            SidebarFooter()
        }
        .background(Chrome.sidebarBackground)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onDeleteCommand { if model.renamingID == nil { model.trash(model.selectedPageIDs) } }
        .onKeyPress(.escape) {
            guard model.sidebarSelection.count > 1, let cur = model.currentSidebarItem else { return .ignored }
            model.sidebarSelection = [cur]
            return .handled
        }
        .onChange(of: model.currentPageID) { _, id in
            // Reveal the open page in the tree, like Notion.
            guard let id else { return }
            for a in model.store.ancestors(of: id) { model.expanded.insert(a.id) }
            if let top = (model.store.ancestors(of: id).last ?? model.store.blocks[id]), let t = top.props.teamspace {
                model.expanded.remove(SidebarTeamspaceRow.closedKey(t))
            }
        }
        .accessibilityIdentifier("sidebar")
    }

    private func createTeamspace() {
        let id = model.store.createTeamspace(name: "New teamspace")
        teamspacesOpen = true
        model.renamingID = "ts:" + id
    }

    /// Lower-cased titles used by more than one top-level page: those rows get a tooltip with location and
    /// creation date so look-alike entries (e.g. several "Teamspace Home" pages) can be told apart.
    static func duplicateTitles(_ pages: [Block], store: WorkspaceStore) -> Set<String> {
        var count: [String: Int] = [:]
        for p in pages { count[store.title(of: p.id).trimmingCharacters(in: .whitespaces).lowercased(), default: 0] += 1 }
        return Set(count.filter { $0.value > 1 }.keys)
    }

    /// Visible rows top to bottom (⇧-click range selection).
    private func visibleOrder(favorites: [Block], teamspaces: [Teamspace], privatePages: [Block]) -> [SidebarItem] {
        if model.sidebarMode == .ai {
            return [.chat(nil), .projects, .inbox, .brain] + (chatsOpen ? happier.chats.prefix(40).map { .chat($0.id) } : [])
        }
        var out: [SidebarItem] = [.home]
        func walk(_ pages: [Block], scope: String) {
            for p in pages {
                out.append(.page(p.id))
                if model.expanded.contains(scope + p.id) { walk(model.store.subpages(of: p.id), scope: scope) }
            }
        }
        if favoritesOpen { walk(favorites, scope: "fav:") }
        if teamspacesOpen {
            for t in teamspaces where !model.expanded.contains(SidebarTeamspaceRow.closedKey(t.id)) {
                walk(model.store.topLevelPages(in: .teamspace(t.id)), scope: "")
            }
        }
        if privateOpen { walk(privatePages, scope: "") }
        out += [.library, .trash, .settings]
        return out
    }
}

/// Notes | AI switch under the workspace row. Each side keeps its own place; ⌥⌘\\ toggles.
struct SidebarModeSwitcher: View {
    @Environment(AppModel.self) private var model
    @Environment(HappierModel.self) private var happier
    /// The highlight slides between Notes and AI (one shared background, matched geometry).
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 2) {
            ForEach(SidebarMode.allCases) { m in
                let on = model.sidebarMode == m
                Button { withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { model.switchSidebar(to: m) } } label: {
                    HStack(spacing: 6) {
                        SymbolImage(name: m.symbol, size: 13)
                        Text(m.title).font(.system(size: 13, weight: on ? .semibold : .medium))
                        if m == .ai, happier.pendingCount > 0 {
                            Circle().fill(Color(Theme.dynamic(light: 0xEB5757, dark: 0xDF5452))).frame(width: 6, height: 6)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 26)
                    .foregroundStyle(on ? Theme.primary : Chrome.sidebarText)
                    .background {
                        if on {
                            RoundedRectangle(cornerRadius: 6).fill(Chrome.selected)
                                .matchedGeometryEffect(id: "sidebar.mode", in: ns)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("sidebar.mode." + m.rawValue)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.045)))
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }
}

/// Pinned bottom of the sidebar: Library, Trash, Settings (outside the scroll view, like Notion).
struct SidebarFooter: View {
    var body: some View {
        VStack(spacing: 1) {
            SidebarNavRow(item: .library, title: "Library", symbol: "books.vertical").accessibilityIdentifier("sidebar.library")
            SidebarNavRow(item: .trash, title: "Trash", symbol: "trash").accessibilityIdentifier("sidebar.trash")
            SidebarNavRow(item: .settings, title: "Settings", symbol: "gearshape").accessibilityIdentifier("sidebar.settings")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(alignment: .top) { Rectangle().fill(Chrome.border).frame(height: 1) }
        .accessibilityIdentifier("sidebar.footer")
    }
}

/// A teamspace in the "Teamspaces" section: icon, name, hover chevron / "…" (rename, delete) / "+", and its
/// top-level pages underneath. Dropping pages onto the row moves them into the teamspace.
struct SidebarTeamspaceRow: View {
    let teamspace: Teamspace
    let order: [SidebarItem]
    let duplicateTitles: Set<String>
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var dropTargeted = false
    @State private var confirmDelete = false

    /// Teamspaces start open; the set stores the closed ones.
    static func closedKey(_ id: RecordID) -> String { "teamspace.closed:" + id }

    var body: some View {
        let store = model.store
        let open = !model.expanded.contains(Self.closedKey(teamspace.id))
        let pages = store.topLevelPages(in: .teamspace(teamspace.id))
        VStack(alignment: .leading, spacing: 1) {
            header(open: open, count: pages.count)
            if open {
                if pages.isEmpty {
                    SidebarEmptyRow(depth: 1)
                } else {
                    ForEach(pages, id: \.id) {
                        SidebarPageRow(page: $0, depth: 1, order: order, scope: "", duplicateTitles: duplicateTitles).id($0.id)
                    }
                }
            }
        }
        .confirmationDialog("Delete teamspace “\(teamspace.name)”?", isPresented: $confirmDelete) {
            Button("Delete teamspace", role: .destructive) { store.deleteTeamspace(teamspace.id) }
        } message: {
            Text("Its \(pages.count) page\(pages.count == 1 ? "" : "s") move to Private. No page is deleted.")
        }
    }

    private func toggle() {
        let key = Self.closedKey(teamspace.id)
        if model.expanded.contains(key) { model.expanded.remove(key) } else { model.expanded.insert(key) }
    }

    private func header(open: Bool, count: Int) -> some View {
        HStack(spacing: 0) {
            ZStack {
                if hover {
                    SidebarChevron(open: open, action: toggle)
                } else {
                    TeamspaceIcon(teamspace: teamspace)
                }
            }
            .frame(width: 20, height: 20)
            if model.renamingID == "ts:" + teamspace.id {
                SidebarRenameField(initial: teamspace.name) { name in
                    if !name.isEmpty { model.store.renameTeamspace(teamspace.id, to: name) }
                }
                .padding(.leading, 8)
            } else {
                Text(teamspace.name.nonEmptyOr("Untitled teamspace"))
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.leading, 8)
            }
            Spacer(minLength: 4)
            if hover {
                Menu {
                    Button("Rename teamspace", systemImage: "pencil") { model.renamingID = "ts:" + teamspace.id }
                    Button("Add a page", systemImage: "plus") { model.newTopLevelPage(in: .teamspace(teamspace.id)) }
                    Divider()
                    Button("Delete teamspace…", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: { SidebarHoverIcon(symbol: "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Teamspace settings")
                Button { model.newTopLevelPage(in: .teamspace(teamspace.id)) } label: { SidebarHoverIcon(symbol: "plus") }
                    .buttonStyle(.plain)
                    .help("Add a page to \(teamspace.name)")
            }
        }
        .foregroundStyle(Chrome.sidebarText)
        .padding(.leading, 8).padding(.trailing, 4)
        .frame(height: Chrome.rowHeight)
        .background(RoundedRectangle(cornerRadius: 6).fill(dropTargeted ? Chrome.accent.opacity(0.18) : (hover ? Chrome.hover : .clear)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(perform: toggle)
        .contextMenu {
            Button("Rename teamspace", systemImage: "pencil") { model.renamingID = "ts:" + teamspace.id }
            Button("Add a page", systemImage: "plus") { model.newTopLevelPage(in: .teamspace(teamspace.id)) }
            Divider()
            Button("Delete teamspace…", systemImage: "trash", role: .destructive) { confirmDelete = true }
        }
        .onDrop(of: [.text], delegate: SidebarSectionDropDelegate(destination: .teamspace(teamspace.id), model: model, targeted: $dropTargeted))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Teamspace \(teamspace.name), \(count) pages")
        .accessibilityIdentifier("sidebar.teamspace")
    }
}

struct TeamspaceIcon: View {
    let teamspace: Teamspace
    var body: some View {
        if let icon = teamspace.icon {
            PageIconView(icon: icon, isDatabase: false, size: 16)
        } else {
            Text(String(teamspace.name.prefix(1)).uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color(Theme.dynamic(light: 0x9B9A97, dark: 0x5A5A5A))))
        }
    }
}

/// Disclosure chevron shown in the icon slot while hovering a row.
struct SidebarChevron: View {
    let open: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .rotationEffect(.degrees(open ? 90 : 0))
                .frame(width: 20, height: 20)
                .background(RoundedRectangle(cornerRadius: 4).fill(Chrome.selected))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(open ? "Collapse" : "Expand")
        .accessibilityIdentifier("sidebar.toggle")
    }
}

/// 20 pt hover icon ("…" and "+") at the right of a row.
struct SidebarHoverIcon: View {
    let symbol: String
    @State private var hover = false
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .semibold))
            .frame(width: 20, height: 20)
            .background(RoundedRectangle(cornerRadius: 4).fill(hover ? Chrome.selected : .clear))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
    }
}

/// "No pages inside" under an expanded page / teamspace without sub-pages.
struct SidebarEmptyRow: View {
    let depth: Int
    var body: some View {
        Text("No pages inside")
            .font(.system(size: 13))
            .foregroundStyle(Chrome.sectionText)
            .padding(.leading, 8 + CGFloat(depth) * Chrome.indentPerLevel + 28)
            .frame(height: 26)
            .accessibilityIdentifier("sidebar.noPagesInside")
    }
}

/// Inline rename field (context menu → Rename). Return or leaving the field commits, Esc cancels.
struct SidebarRenameField: View {
    let initial: String
    let commit: (String) -> Void
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var done = false
    @FocusState private var focused: Bool

    var body: some View {
        TextField("Untitled", text: $text)
            .textFieldStyle(.plain)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Theme.primary)
            .padding(.horizontal, 4)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 4).fill(Chrome.appBackground))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Chrome.accent.opacity(0.6)))
            .focused($focused)
            .onAppear { text = initial; focused = true }
            .onSubmit(finish)
            .onChange(of: focused) { _, f in if !f { finish() } }
            .onKeyPress(.escape) {
                done = true
                model.renamingID = nil
                return .handled
            }
            .accessibilityIdentifier("sidebar.renameField")
    }

    private func finish() {
        guard !done else { return }
        done = true
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t != initial { commit(t) }
        model.renamingID = nil
    }
}

/// Workspace switcher row at the top of the sidebar, with "collapse" (on hover) and "new page".
struct SidebarWorkspaceRow: View {
    var floating = false
    @Environment(AppModel.self) private var model
    @State private var hover = false

    @State private var showMenu = false

    var body: some View {
        let w = model.store.workspace
        HStack(spacing: 4) {
            // A Button + popover instead of `Menu`: macOS menu buttons only render the label's first text,
            // which showed just the initial ("M") and nothing to rename.
            Button { showMenu.toggle() } label: {
                HStack(spacing: 8) {
                    WorkspaceBadge(workspace: w, size: 22)
                    Text(w.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.primary).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Chrome.sidebarText)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showMenu, arrowEdge: .bottom) { WorkspaceMenu { showMenu = false } }
            .accessibilityIdentifier("sidebar.workspace")
            Spacer(minLength: 4)
            if hover && !floating {
                ChromeIconButton(symbol: "chevron.left.2", size: 12, help: "Close sidebar (⌘\\)") { model.toggleSidebar() }
            }
            ChromeIconButton(symbol: "square.and.pencil", size: 15, help: "New page") { model.newPage() }
                .accessibilityIdentifier("toolbar.newPage")
        }
        .padding(.leading, 14).padding(.trailing, 10)
        .frame(height: 46)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// Workspace icon: its emoji / image, else the first letter of the name.
struct WorkspaceBadge: View {
    let workspace: Workspace
    var size: CGFloat = 22

    var body: some View {
        if let icon = workspace.icon {
            PageIconView(icon: icon, size: size * 0.8).frame(width: size, height: size)
        } else {
            Text(String(workspace.name.prefix(1)).uppercased())
                .font(.system(size: size * 0.55, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(RoundedRectangle(cornerRadius: size * 0.23).fill(Color(Theme.dynamic(light: 0x787774, dark: 0x5A5A5A))))
        }
    }
}

/// Workspace popover: rename in place, icon, settings, import / export, sync.
struct WorkspaceMenu: View {
    let close: () -> Void
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        let w = model.store.workspace
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                IconPickerButton(icon: w.icon) { model.setWorkspaceIcon($0) }
                TextField("Workspace name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .focused($nameFocused)
                    .onSubmit { commit(); close() }
                    .onChange(of: name) { _, _ in commit() }
                    .accessibilityIdentifier("workspace.name")
            }
            .padding(.bottom, 6)
            if model.syncStatus != "Off" && model.syncStatus != "Not configured" {
                Text("Sync: \(model.syncStatus)").font(.caption).foregroundStyle(Theme.secondary).padding(.bottom, 4)
            }
            Divider().padding(.vertical, 4)
            row("Settings", "gearshape") { model.openSettings() }
            row("Import from Notion…", "square.and.arrow.down.on.square") { model.showNotionImport = true }
            row("Import file…", "square.and.arrow.down") { model.showImport = true }
            row("Export workspace…", "square.and.arrow.up") { model.showExportAll = true }
            row("Sync now", "arrow.triangle.2.circlepath") { model.syncNow() }
        }
        .padding(12)
        .frame(width: 280)
        .onAppear { name = w.name }
    }

    private func commit() {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !n.isEmpty, n != model.store.workspace.name { model.store.renameWorkspace(n) }
    }

    private func row(_ title: String, _ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button { close(); action() } label: {
            Label(title, systemImage: symbol).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 6).padding(.vertical, 5).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// "Search ⌘K" row.
struct SidebarSearchRow: View {
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 15)).frame(width: 20, height: 20)
            Text("Search").font(.system(size: 14, weight: .medium))
            Spacer(minLength: 4)
            if hover { Text("⌘K").font(.system(size: 12)).foregroundStyle(Chrome.sectionText) }
        }
        .foregroundStyle(Chrome.sidebarText)
        .padding(.horizontal, 8)
        .frame(height: Chrome.rowHeight)
        .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Chrome.hover : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { model.showQuickFind = true }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("sidebar.search")
    }
}

/// A fixed sidebar destination (Home, Inbox, Settings, a chat…).
struct SidebarNavRow: View {
    let item: SidebarItem
    let title: String
    let symbol: String
    var badge = 0
    var order: [SidebarItem] = []
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        let selected = SidebarClick.isHighlighted(item, model: model)
        HStack(spacing: 8) {
            SymbolImage(name: symbol, size: 15).frame(width: 20, height: 20)
            Text(title).font(.system(size: 14, weight: .medium)).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            if badge > 0 {
                Text("\(badge)").font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 6).frame(height: 16)
                    .background(Capsule().fill(Color(Theme.dynamic(light: 0xEB5757, dark: 0xDF5452))))
            }
        }
        .foregroundStyle(selected ? Theme.primary : Chrome.sidebarText)
        .padding(.horizontal, 8)
        .frame(height: Chrome.rowHeight)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Chrome.selected : (hover ? Chrome.hover : .clear)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture {
            if order.isEmpty { SidebarClick.navigate(item, model: model) } else { SidebarClick.click(item, model: model, order: order) }
        }
        .contextMenu {
            if case .chat(let id?) = item {
                SidebarContextMenu(items: model.sidebarSelection.contains(item) && model.sidebarSelection.count > 1 ? Array(model.sidebarSelection) : [.chat(id)])
            } else {
                Button("Open in new tab", systemImage: "plus.rectangle.on.rectangle") { model.newTab(item) }
                if item == .home {
                    Divider()
                    if let id = model.currentPageID, !model.isHome(id) {
                        Button("Use current page as Home", systemImage: "house") { model.setHome(id) }
                    }
                    if model.homePageID != nil {
                        Button("Choose another Home page…", systemImage: "arrow.triangle.2.circlepath") { model.setHome(nil); model.goHome() }
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Secondary action row ("Add new", "View all").
struct SidebarActionRow: View {
    let title: String
    let symbol: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 12)).frame(width: 22, height: 22)
            Text(title).font(.system(size: 14))
            Spacer(minLength: 0)
        }
        .foregroundStyle(Chrome.sectionText)
        .padding(.horizontal, 8)
        .frame(height: Chrome.rowHeight)
        .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Chrome.hover : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(perform: action)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// Import menu row (Notion API / file export).
struct SidebarImportRow: View {
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        Menu {
            Button("From Notion (API)…", systemImage: "square.and.arrow.down.on.square") { model.showNotionImport = true }
            Button("From file (Notion export, Markdown, CSV, HTML)…", systemImage: "doc.zipper") { model.showImport = true }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.arrow.down").font(.system(size: 14)).frame(width: 22, height: 22)
                Text("Import").font(.system(size: 14, weight: .medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(Chrome.sidebarText)
            .padding(.horizontal, 8)
            .frame(height: Chrome.rowHeight)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Chrome.hover : .clear))
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .onHover { hover = $0 }
        .accessibilityIdentifier("sidebar.import")
    }
}

/// Section title ("Favorites", "Teamspaces", "Private", "Chats"): small gray label, click folds, hover shows
/// the chevron and a "+" when the section has an add action.
struct SidebarSectionHeader: View {
    let title: String
    @Binding var open: Bool
    var addHelp = "Add"
    var dropTargeted = false
    var onAdd: (() -> Void)?
    @State private var hover = false

    var body: some View {
        HStack(spacing: 4) {
            Text(title).font(.system(size: 12, weight: .medium))
            Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold))
                .rotationEffect(.degrees(open ? 90 : 0))
                .opacity(hover ? 1 : 0)
            Spacer(minLength: 0)
            if hover, let onAdd {
                Button(action: onAdd) { SidebarHoverIcon(symbol: "plus") }
                    .buttonStyle(.plain)
                    .help(addHelp)
                    .accessibilityIdentifier("sidebar.section." + title.lowercased() + ".add")
            }
        }
        .foregroundStyle(Chrome.sectionText)
        .padding(.leading, 8).padding(.trailing, 4)
        .frame(height: 26)
        .background(RoundedRectangle(cornerRadius: 6).fill(dropTargeted ? Chrome.accent.opacity(0.18) : (hover ? Chrome.hover.opacity(0.6) : .clear)))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
        .onTapGesture { withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) { open.toggle() } }
        .padding(.top, 12)
        .accessibilityIdentifier("sidebar.section." + title.lowercased())
    }
}

/// One page in the sidebar tree: icon (turns into a disclosure chevron on hover), title, "…" menu and "+".
/// Drag onto the middle nests the page inside, onto the top / bottom edge reorders. `scope` separates the
/// Favorites copy of a row ("fav:") from the tree row ("") for expansion and inline rename.
struct SidebarPageRow: View {
    let page: Block
    let depth: Int
    let order: [SidebarItem]
    var scope = ""
    var duplicateTitles: Set<String> = []
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var zone: PageDropZone?

    var body: some View {
        let node = model.registry.block(page.id)
        let _ = node.children
        let current = node.block ?? page
        let isOpen = model.expanded.contains(scope + page.id)
        VStack(alignment: .leading, spacing: 1) {
            row(current, isOpen: isOpen)
            if isOpen && current.type == .page {
                let subs = model.store.subpages(of: page.id)
                if subs.isEmpty {
                    SidebarEmptyRow(depth: depth + 1)
                } else {
                    ForEach(subs, id: \.id) {
                        SidebarPageRow(page: $0, depth: depth + 1, order: order, scope: scope).id(scope + $0.id)
                    }
                }
            }
        }
    }

    private var menuItems: [SidebarItem] {
        let item = SidebarItem.page(page.id)
        let s = model.sidebarSelection
        return s.count > 1 && s.contains(item) ? Array(s) : [item]
    }

    private func toggle() {
        let key = scope + page.id
        if model.expanded.contains(key) { model.expanded.remove(key) } else { model.expanded.insert(key) }
    }

    /// Tooltip for look-alike rows: where the page lives and when it was created.
    private func disambiguation(_ page: Block, title: String) -> String {
        guard depth == 0 || page.parent == .workspace,
              duplicateTitles.contains(title.trimmingCharacters(in: .whitespaces).lowercased()) else { return "" }
        let store = model.store
        let section = page.props.teamspace.flatMap { store.teamspace($0)?.name } ?? "Private"
        return "\(title) — \(section), created \(page.createdAt.formatted(date: .abbreviated, time: .shortened))"
    }

    private func row(_ page: Block, isOpen: Bool) -> some View {
        let store = model.store
        let item = SidebarItem.page(page.id)
        let isDB = page.type == .databasePage || page.type == .databaseInline
        if isDB, let db = page.props.databaseID { let _ = model.registry.database(db).revision }
        let selected = SidebarClick.isHighlighted(item, model: model)
        let expandable = page.type == .page
        let title = store.title(of: page.id)
        let renaming = model.renamingID == scope + page.id
        return HStack(spacing: 0) {
            ZStack {
                if hover && expandable && !renaming {
                    SidebarChevron(open: isOpen, action: toggle)
                } else {
                    PageIconView(icon: page.props.icon, isDatabase: isDB, size: 16)
                }
            }
            .frame(width: 20, height: 20)
            if renaming {
                SidebarRenameField(initial: title) { store.renamePage(page.id, to: $0) }
                    .padding(.leading, 6)
            } else {
                Text(title.nonEmptyOr("Untitled"))
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 8)
            }
            Spacer(minLength: 4)
            if hover && !renaming {
                Menu { SidebarContextMenu(items: menuItems, scope: scope) } label: { SidebarHoverIcon(symbol: "ellipsis") }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Delete, duplicate, and more…")
                    .accessibilityIdentifier("sidebar.page.more")
                if page.type == .page {
                    Button { model.newPage(in: .block(page.id)) } label: { SidebarHoverIcon(symbol: "plus") }
                        .buttonStyle(.plain)
                        .help("Add a page inside")
                        .accessibilityIdentifier("sidebar.page.add")
                }
            }
        }
        .foregroundStyle(selected ? Theme.primary : Chrome.sidebarText)
        .padding(.leading, 8 + CGFloat(depth) * Chrome.indentPerLevel)
        .padding(.trailing, 4)
        .frame(height: Chrome.rowHeight)
        .background(RoundedRectangle(cornerRadius: 6).fill(zone == .inside ? Chrome.accent.opacity(0.18) : (selected ? Chrome.selected : (hover ? Chrome.hover : .clear))))
        .overlay(alignment: zone == .after ? .bottom : .top) {
            if zone == .before || zone == .after {
                Rectangle().fill(Chrome.accent).frame(height: 2).padding(.leading, 8 + CGFloat(depth) * Chrome.indentPerLevel)
            }
        }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { if !renaming { SidebarClick.click(item, model: model, order: order) } }
        .contextMenu { SidebarContextMenu(items: menuItems, scope: scope) }
        .help(disambiguation(page, title: title))
        .onDrag {
            let selected = model.selectedPageIDs
            model.draggedBlocks = selected.contains(page.id) ? selected : [page.id]
            return NSItemProvider(object: page.id as NSString)
        }
        .onDrop(of: [.text], delegate: SidebarDropDelegate(page: page, model: model, zone: $zone, scope: scope))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("sidebar.page")
    }
}

/// Drop on a page row: middle third nests (pages only), top / bottom edge reorders next to it, keeping the
/// target's section (Private / teamspace / parent page). Page moves go through `WorkspaceStore.dropPages`
/// (one undo step, cycle-safe); dragged non-page blocks are appended inside the target page.
struct SidebarDropDelegate: DropDelegate {
    let page: Block
    let model: AppModel
    @Binding var zone: PageDropZone?
    var scope = ""

    private func zone(at y: CGFloat) -> PageDropZone {
        let canNest = page.type == .page
        if !canNest { return y < Chrome.rowHeight / 2 ? .before : .after }
        if y < 7 { return .before }
        if y > Chrome.rowHeight - 7 { return .after }
        return .inside
    }

    func validateDrop(info: DropInfo) -> Bool { !model.draggedBlocks.isEmpty }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        zone = zone(at: info.location.y)
        return DropProposal(operation: .move)
    }
    func dropExited(info: DropInfo) { zone = nil }

    func performDrop(info: DropInfo) -> Bool {
        let z = zone(at: info.location.y)
        zone = nil
        let store = model.store
        let ids = model.draggedBlocks.filter { $0 != page.id && !store.isDescendant(page.id, of: $0) }
        model.draggedBlocks = []
        guard !ids.isEmpty else { return false }
        if ids.allSatisfy({ store.blocks[$0]?.type.isPageLike == true }) {
            guard store.dropPages(ids, onto: page.id, zone: z) else { return false }
        } else {
            guard z == .inside, page.type == .page else { return false }
            store.moveBlocks(ids, to: .block(page.id), at: .end)
        }
        if z == .inside { model.expanded.insert(scope + page.id) }
        return true
    }
}

/// Drop on a section header ("Private") or a teamspace row: moves the dragged pages to its top level.
struct SidebarSectionDropDelegate: DropDelegate {
    let destination: PageDestination
    let model: AppModel
    @Binding var targeted: Bool

    func validateDrop(info: DropInfo) -> Bool {
        !model.draggedBlocks.isEmpty && model.draggedBlocks.allSatisfy { model.store.blocks[$0]?.type.isPageLike == true }
    }
    func dropEntered(info: DropInfo) { targeted = true }
    func dropExited(info: DropInfo) { targeted = false }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
    func performDrop(info: DropInfo) -> Bool {
        targeted = false
        let ids = model.draggedBlocks
        model.draggedBlocks = []
        guard !ids.isEmpty else { return false }
        model.store.movePages(ids, to: destination)
        if case .teamspace(let t) = destination { model.expanded.remove(SidebarTeamspaceRow.closedKey(t)) }
        return true
    }
}

// MARK: - Top bars

/// Notion's page top bar: breadcrumb, "Edited …", Share, AI, favourite and the "•••" menu.
struct PageTopBar: View {
    let page: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 2) {
            PageBreadcrumb(pageID: page.id)
            Spacer(minLength: 8)
            ViewThatFits(in: .horizontal) {
                Text("Edited \(page.updatedAt.formatted(.relative(presentation: .named)))")
                    .font(.system(size: 13)).foregroundStyle(Chrome.sectionText).lineLimit(1).padding(.trailing, 6)
                Color.clear.frame(width: 0, height: 0)
            }
            Menu {
                Button("Copy link", systemImage: "link") { Clipboard.copyLinks([page.id], store: model.store) }
                Button("Export…", systemImage: "square.and.arrow.up") { model.exportRequest = AppModel.ExportRequest(pageID: page.id) }
            } label: {
                Text("Share").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.primary)
                    .padding(.horizontal, 8).frame(height: 28)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityIdentifier("page.share")
            ChromeIconButton(symbol: SymbolImage.ai, size: 15, help: "Ask AI (⌘J)", active: model.showChatPanel) { model.toggleChatPanel() }
                .accessibilityIdentifier("toolbar.chat")
            FavoriteButton(pageID: page.id)
                .buttonStyle(ChromeHoverButtonStyle())
                .font(.system(size: 15))
                .foregroundStyle(Chrome.sidebarText)
            PageOptionsButton(page: page, editor: editor)
        }
        .padding(.leading, 12).padding(.trailing, 10)
        .frame(height: Chrome.topBarHeight)
        .background(Chrome.appBackground)
        .accessibilityIdentifier("page.topbar")
    }
}

/// "Workspace / Parent / Page" with icons; middle levels collapse to "…" when deep.
struct PageBreadcrumb: View {
    let pageID: RecordID
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.store
        let chain = store.ancestors(of: pageID).filter { $0.type.isPageLike }.reversed() + [store.blocks[pageID]].compactMap { $0 }
        let shown: [Block?] = chain.count > 4 ? [chain.first] + [nil] + chain.suffix(2).map { Optional($0) } : chain.map { Optional($0) }
        HStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { i, b in
                if i > 0 { Text("/").font(.system(size: 13)).foregroundStyle(Chrome.sectionText).padding(.horizontal, 2) }
                if let b {
                    BreadcrumbItem(page: b, isLast: i == shown.count - 1)
                } else {
                    Text("…").font(.system(size: 14)).foregroundStyle(Chrome.sidebarText).padding(.horizontal, 4)
                }
            }
        }
        .lineLimit(1)
        .accessibilityIdentifier("page.breadcrumb")
    }
}

struct BreadcrumbItem: View {
    let page: Block
    let isLast: Bool
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            PageIconView(icon: page.props.icon, isDatabase: page.type == .databasePage, size: 16)
            Text(model.store.title(of: page.id).nonEmptyOr("Untitled"))
                .font(.system(size: 14))
                .foregroundStyle(isLast ? Theme.primary : Chrome.sidebarText)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 6)
        .frame(height: 26)
        .frame(maxWidth: 220, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        .background(RoundedRectangle(cornerRadius: 5).fill(hover ? Chrome.hover : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { if !isLast { model.open(page.id) } }
    }
}

/// Top bar for non-page screens (Home, Agents, Inbox, Settings…).
struct ScreenTopBar: View {
    let item: SidebarItem
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: item.symbol).font(.system(size: 13)).foregroundStyle(Chrome.sidebarText)
            Text(item.title(in: model)).font(.system(size: 14)).foregroundStyle(Theme.primary).lineLimit(1)
            Spacer(minLength: 8)
            if case .chat = item {} else {
                ChromeIconButton(symbol: SymbolImage.ai, size: 15, help: "Ask AI (⌘J)", active: model.showChatPanel) { model.toggleChatPanel() }
                    .accessibilityIdentifier("toolbar.chat")
            }
        }
        .padding(.leading, 18).padding(.trailing, 10)
        .frame(height: Chrome.topBarHeight)
        .background(Chrome.appBackground)
    }
}
#endif
