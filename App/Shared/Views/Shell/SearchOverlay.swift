import SwiftUI
import BasedCore
import BasedBrain

// MARK: - ⌘K / ⌘P search

/// Notion-style search: pages or chats, grouped by date, "Ask AI" row, ⌘↵ opens in a new tab, ⌘L copies a link.
struct SearchOverlay: View {
    enum Scope: String, CaseIterable, Identifiable { case pages = "Pages", chats = "Chats"; var id: String { rawValue } }

    struct Row: Identifiable {
        enum Kind { case page(RecordID, snippet: String?), chat(AgentSession), ask(String) }
        let id: String
        let kind: Kind
        let section: String
    }

    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain
    @Environment(HappierModel.self) private var happier
    @State private var query = ""
    @State private var scope: Scope = .pages
    @State private var titleOnly = false
    @State private var sort: SearchSort = .bestMatch
    @State private var highlighted = 0
    @State private var rows: [Row] = []
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.secondary).font(.system(size: 16))
                TextField("Search or ask a question in \(model.store.workspace.name)…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17))
                    .focused($focused)
                    .onSubmit { activate(newTab: false) }
                    .onKeyPress(.downArrow) { move(+1); return .handled }
                    .onKeyPress(.upArrow) { move(-1); return .handled }
                    .onKeyPress(.tab) { scope = scope == .pages ? .chats : .pages; return .handled }
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.contains(.command) else { return .ignored }
                        activate(newTab: true)
                        return .handled
                    }
                    .onKeyPress(.escape) { close(); return .handled }
                    .accessibilityIdentifier("quickfind.field")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(Theme.secondary)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            filters
            Divider()
            results
            Divider()
            footer
        }
        .frame(width: 680)
        .frame(minHeight: 300, maxHeight: 560)
        .onAppear { focused = true; recompute() }
        .onChange(of: query) { _, _ in highlighted = 0; recompute() }
        .onChange(of: scope) { _, _ in highlighted = 0; recompute() }
        .onChange(of: titleOnly) { _, _ in recompute() }
        .onChange(of: sort) { _, _ in recompute() }
        .background {
            Button("") { copyLink() }.keyboardShortcut("l").opacity(0).frame(width: 0, height: 0)
        }
        .accessibilityIdentifier("quickfind")
    }

    private var filters: some View {
        HStack(spacing: 8) {
            Picker("", selection: $scope) {
                ForEach(Scope.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .accessibilityIdentifier("quickfind.scope")
            if scope == .pages {
                Toggle("Title only", isOn: $titleOnly).toggleStyle(.button)
                Picker("Sort", selection: $sort) {
                    Text("Best match").tag(SearchSort.bestMatch)
                    Text("Last edited: newest").tag(SearchSort.lastEditedNewest)
                    Text("Last edited: oldest").tag(SearchSort.lastEditedOldest)
                    Text("Created: newest").tag(SearchSort.createdNewest)
                    Text("Created: oldest").tag(SearchSort.createdOldest)
                }
                .fixedSize()
            }
            Spacer()
        }
        .controlSize(.small)
        .font(.system(size: 12))
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    private var results: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if rows.isEmpty {
                        Text(query.isEmpty ? (scope == .chats ? "No chats yet" : "No pages yet") : "No results")
                            .foregroundStyle(Theme.secondary).padding(16)
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
                        if i == 0 || rows[i - 1].section != r.section, !r.section.isEmpty {
                            Text(r.section).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.secondary)
                                .padding(.horizontal, 16).padding(.top, i == 0 ? 8 : 14).padding(.bottom, 4)
                        }
                        Button { highlighted = i; activate(newTab: false) } label: { rowView(r, highlighted: i == highlighted) }
                            .buttonStyle(.plain)
                            .id(r.id)
                            .onHover { if $0 { highlighted = i } }
                    }
                }
                .padding(.vertical, 6)
            }
            .onChange(of: highlighted) { _, i in if rows.indices.contains(i) { proxy.scrollTo(rows[i].id) } }
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            Text("↑↓ Select")
            Text("↵ Open")
            Text("⌘↵ Open in new tab")
            Text("⌘L Copy link")
            Spacer()
            Text("⇥ Pages / Chats")
        }
        .font(.system(size: 11))
        .foregroundStyle(Theme.secondary)
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    @ViewBuilder
    private func rowView(_ r: Row, highlighted: Bool) -> some View {
        let store = model.store
        HStack(alignment: .center, spacing: 10) {
            switch r.kind {
            case .ask(let q):
                Image(systemName: "sparkles").foregroundStyle(Color.accentColor).frame(width: 20)
                Text("Ask AI: ").foregroundStyle(Theme.secondary) + Text("“\(q)”").fontWeight(.medium)
            case .chat(let c):
                Image(systemName: "bubble.left").foregroundStyle(Theme.secondary).frame(width: 20)
                Text(c.title.isEmpty ? "New chat" : c.title).lineLimit(1)
                Spacer(minLength: 8)
                Text(c.updatedAt.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(Theme.secondary)
            case .page(let id, let snippet):
                PageIconView(icon: store.icon(of: id), isDatabase: store.blocks[id]?.type == .databasePage, size: 18).frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(store.title(of: id).nonEmptyOr("Untitled")).font(.system(size: 14, weight: .medium)).lineLimit(1)
                        let path = pathText(id)
                        if !path.isEmpty { Text("— " + path).font(.system(size: 12)).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.head) }
                    }
                    if let s = snippet, !s.isEmpty { Text(s).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1) }
                }
                Spacer(minLength: 8)
                if highlighted {
                    Text("↵").font(.caption).foregroundStyle(Theme.secondary)
                } else if let b = store.blocks[id] {
                    Text(b.updatedAt.formatted(date: .abbreviated, time: .omitted)).font(.caption2).foregroundStyle(Theme.secondary)
                }
            }
            if case .page = r.kind {} else { Spacer(minLength: 0) }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 6).fill(highlighted ? Color.primary.opacity(0.07) : Color.clear))
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
    }

    private func pathText(_ id: RecordID) -> String {
        let store = model.store
        return store.ancestors(of: id).filter { $0.type.isPageLike }.reversed()
            .map { store.title(of: $0.id).nonEmptyOr("Untitled") }.joined(separator: " / ")
    }

    // MARK: Results

    private func recompute() {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var out: [Row] = []
        if !q.isEmpty { out.append(Row(id: "ask", kind: .ask(q), section: "")) }
        switch scope {
        case .pages:
            if q.isEmpty {
                for b in model.store.recentPages(limit: 40) where b.id != model.brain.brain.rootID {
                    out.append(Row(id: b.id, kind: .page(b.id, snippet: nil), section: Self.bucket(b.updatedAt)))
                }
            } else {
                var f = SearchFilters()
                f.titleOnly = titleOnly
                let hits = Log.measure("search", category: "ui", warnAfter: 0.08) {
                    SearchEngine(store: model.store).search(q, filters: f, sort: sort, limit: 60)
                }
                for h in hits {
                    let section = sort == .bestMatch ? "Best matches" : Self.bucket(model.store.blocks[h.pageID]?.updatedAt ?? .distantPast)
                    out.append(Row(id: h.pageID, kind: .page(h.pageID, snippet: h.snippet), section: section))
                }
            }
        case .chats:
            for c in happier.chats where q.isEmpty || c.title.localizedCaseInsensitiveContains(q) {
                out.append(Row(id: c.id, kind: .chat(c), section: Self.bucket(c.updatedAt)))
            }
        }
        rows = out
        if !q.isEmpty, out.count > 1, highlighted == 0 { highlighted = 1 }   // first real hit, "Ask AI" stays one ↑ away
    }

    /// Notion's date groups.
    static func bucket(_ d: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: d, to: now).day ?? 0
        if days < 7 { return "Past week" }
        if days < 30 { return "Past 30 days" }
        return "Older"
    }

    private func move(_ d: Int) {
        guard !rows.isEmpty else { return }
        highlighted = min(rows.count - 1, max(0, highlighted + d))
    }

    private func activate(newTab: Bool) {
        guard rows.indices.contains(highlighted) else { return }
        let r = rows[highlighted]
        close()
        switch r.kind {
        case .page(let id, _):
            Log.breadcrumb("search → open \(id.prefix(6))\(newTab ? " (new tab)" : "")")
            if newTab { model.openInNewTab(id) } else { model.open(id) }
        case .chat(let c):
            if newTab { model.newTab(.chat(c.id)) ; model.brain.openChat(c.id) } else { model.openChat(c.id, fullPage: true) }
        case .ask(let q):
            model.openChat(nil, fullPage: false)
            brain.ask(q, pageContext: model.currentPageID)
        }
    }

    private func copyLink() {
        guard rows.indices.contains(highlighted) else { return }
        switch rows[highlighted].kind {
        case .page(let id, _): Clipboard.copy("based://page/" + id)
        case .chat(let c): Clipboard.copy("based://chat/" + c.id)
        case .ask: return
        }
    }

    private func close() { model.showQuickFind = false }
}

// MARK: - ⌘N command palette

/// "New…" palette: page, AI chat, meeting notes, database, agent session, import. Digits pick directly.
struct CommandPalette: View {
    struct Item: Identifiable {
        let id: Int
        let title: String
        let detail: String
        let symbol: String
        let run: @MainActor (AppModel) -> Void
    }

    @Environment(AppModel.self) private var model
    @State private var filter = ""
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    static let items: [Item] = [
        Item(id: 1, title: "New page", detail: "Empty page in Private", symbol: "doc") { $0.newPage() },
        Item(id: 2, title: "New AI chat", detail: "Ask about your workspace", symbol: "bubble.left.and.text.bubble.right") { $0.openChat(nil, fullPage: true) },
        Item(id: 3, title: "New meeting notes", detail: "Attendees, agenda, notes, action items", symbol: "person.2.wave.2") { $0.newMeetingNotes() },
        Item(id: 4, title: "New database", detail: "Full-page table", symbol: "tablecells") { m in
            let c = m.store.createDatabase(in: .workspace, inline: false, viewType: .table)
            m.openRoot(c.blockID)
        },
        Item(id: 5, title: "New agent session", detail: "Claude Code, Codex … in a folder", symbol: "terminal") { $0.showNewSession = true },
        Item(id: 6, title: "Import…", detail: "Notion export (.zip), Markdown, CSV, HTML", symbol: "square.and.arrow.down") { $0.showImport = true },
    ]

    private var visible: [Item] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? Self.items : Self.items.filter { $0.title.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        let list = visible
        VStack(alignment: .leading, spacing: 0) {
            TextField("Create new…", text: $filter)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .focused($focused)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .onSubmit { run(list, highlighted) }
                .onKeyPress(.downArrow) { highlighted = min(list.count - 1, highlighted + 1); return .handled }
                .onKeyPress(.upArrow) { highlighted = max(0, highlighted - 1); return .handled }
                .onKeyPress(.escape) { model.showCommandPalette = false; return .handled }
                .onKeyPress(characters: .decimalDigits) { press in
                    guard filter.isEmpty, let n = Int(press.characters), let i = list.firstIndex(where: { $0.id == n }) else { return .ignored }
                    run(list, i)
                    return .handled
                }
                .accessibilityIdentifier("palette.field")
            Divider()
            VStack(spacing: 2) {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, item in
                    Button { run(list, i) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: item.symbol).frame(width: 22).foregroundStyle(Theme.secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.title).font(.system(size: 14, weight: .medium))
                                Text(item.detail).font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
                            }
                            Spacer()
                            Text("\(item.id)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 4).stroke(Color(Theme.divider)))
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 6).fill(i == highlighted ? Color.primary.opacity(0.07) : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { if $0 { highlighted = i } }
                    .accessibilityIdentifier("palette.item\(item.id)")
                }
            }
            .padding(6)
        }
        .frame(width: 440)
        .onAppear { focused = true }
        .onChange(of: filter) { _, _ in highlighted = 0 }
        .accessibilityIdentifier("palette")
    }

    private func run(_ list: [Item], _ i: Int) {
        guard list.indices.contains(i) else { return }
        model.showCommandPalette = false
        Log.breadcrumb("palette → \(list[i].title)")
        list[i].run(model)
    }
}

extension AppModel {
    /// ⌘N → "New meeting notes": a dated page with the usual sections.
    func newMeetingNotes() {
        let now = Date()
        let id = store.createPage(title: RichText("Meeting notes — " + now.formatted(date: .abbreviated, time: .omitted)),
                                  icon: .emoji("🗓️"), name: "New meeting notes")
        let md = """
        **Date:** \(now.formatted(date: .long, time: .shortened))
        **Attendees:** 

        ## Agenda
        - 

        ## Notes
        - 

        ## Action items
        - [ ] 
        """
        _ = store.insertImported(MarkdownImporter().parse(md), in: .block(id), name: "New meeting notes")
        openRoot(id)
    }
}
