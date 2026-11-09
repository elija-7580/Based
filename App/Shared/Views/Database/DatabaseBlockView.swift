import SwiftUI
import BasedCore

/// Everything a database layout needs for one render.
@MainActor
struct DBContext {
    let block: Block
    let db: Database
    let view: DatabaseView
    let engine: QueryEngine
    let result: QueryResult
    let model: AppModel
    let locked: Bool
    /// Search text the result was filtered with (cache key for `derived`).
    var search: String? = nil

    var store: WorkspaceStore { model.store }
    /// BSD-39: memoizes a computation over `result` until the query result changes (not on every render).
    func derived<T>(_ tag: String, _ compute: () -> T) -> T {
        model.queryCache.derived(view, search: search, tag: tag, compute)
    }
    var visibleProperties: [PropertySchema] {
        view.visiblePropertyIDs(in: db).compactMap { db.property($0) ?? ($0 == db.titleProperty.id ? db.titleProperty : nil) }
    }
    /// Non-title properties shown on cards / list rows.
    var cardProperties: [PropertySchema] { visibleProperties.filter { $0.type != .title } }

    func open(_ rowID: RecordID) {
        model.peekSiblings = (visibleGroups?.flatMap(\.rows) ?? result.rows).map(\.id)
        model.open(rowID, mode: view.openIn ?? .sidePeek)
    }

    @discardableResult
    func addRow(values: [String: PropertyValue] = [:], title: RichText = RichText(), at position: InsertPosition = .end,
                template: RecordID? = nil) -> RecordID {
        store.addRow(to: db.id, title: title, values: prefill().merging(values) { _, new in new }, at: position, template: template)
    }

    /// New rows satisfy simple "is" filters of the current view (like Notion).
    func prefill() -> [String: PropertyValue] {
        guard let f = view.filter, f.combinator == .and else { return [:] }
        var out: [String: PropertyValue] = [:]
        for item in f.items {
            guard case .condition(let c) = item, c.op == .equals || c.op == .contains, let p = db.property(c.propertyID), let v = c.value else { continue }
            switch (p.type, v) {
            case (.select, .options(let ids)) where ids.count == 1: out[p.id] = .select(ids[0])
            case (.status, .options(let ids)) where ids.count == 1: out[p.id] = .status(ids[0])
            case (.multiSelect, .options(let ids)): out[p.id] = .multiSelect(ids)
            case (.checkbox, .bool(let b)): out[p.id] = .checkbox(b)
            case (.text, .text(let t)): out[p.id] = .text(RichText(t))
            case (.person, .options(let ids)): out[p.id] = .person(ids)
            default: break
            }
        }
        return out
    }

    func value(_ row: Block, _ p: PropertySchema) -> Value { engine.value(row, p, db) }

    var groupProperty: PropertySchema? {
        if let g = view.groupBy { return db.property(g.propertyID) }
        if view.type == .board { return db.properties.first { $0.type == .status || $0.type == .select } }
        return nil
    }

    /// Groups honouring the view's hidden / empty-group settings.
    var visibleGroups: [RowGroup]? {
        guard let groups = result.groups else { return nil }
        let hidden = Set(view.groupBy?.hiddenGroups ?? [])
        let hideEmpty = view.groupBy?.hideEmptyGroups == true
        return groups.filter { !hidden.contains($0.id) && !(hideEmpty && $0.rows.isEmpty) }
    }

    var hiddenGroups: [RowGroup] {
        let hidden = Set(view.groupBy?.hiddenGroups ?? [])
        return (result.groups ?? []).filter { hidden.contains($0.id) }
    }

    func setGroupHidden(_ id: String, _ hide: Bool) {
        store.updateView(view.id, name: hide ? "Hide group" : "Show group") { v in
            var g = v.groupBy ?? GroupRule(propertyID: groupProperty?.id ?? "")
            var h = g.hiddenGroups ?? []
            h.removeAll { $0 == id }
            if hide { h.append(id) }
            g.hiddenGroups = h
            v.groupBy = g
        }
    }

    /// Move a row into another group (board drag, "New" in a group).
    func move(_ rowID: RecordID, toGroup gid: String, from old: String?) {
        guard let p = groupProperty, let row = store.blocks[rowID] else { return }
        let nv = engine.valueForGroup(gid, p, existing: row.values[p.id], from: old)
        store.setValue(rowID, p.id, nv)
    }

    func groupValues(_ gid: String) -> [String: PropertyValue] {
        guard let p = groupProperty, let v = engine.valueForGroup(gid, p, existing: nil, from: nil) else { return [:] }
        return [p.id: v]
    }
}

/// An inline database, a full-page database, or a linked view.
struct DatabaseBlockView: View {
    let blockID: RecordID
    let fullPage: Bool
    @Environment(AppModel.self) private var model
    @State private var activeViewID: RecordID?
    @State private var search = ""
    @State private var searching = false
    @State private var showFilter = false
    @State private var showSort = false
    @State private var showSettings = false
    @State private var renamingView: RecordID?
    @State private var viewName = ""
    @FocusState private var searchFocused: Bool
    @FocusState private var renameFocused: Bool

    var body: some View {
        let node = model.registry.block(blockID)
        if let block = node.block, let dbID = block.props.databaseID {
            let dbNode = model.registry.database(dbID)
            let _ = dbNode.revision
            if let db = dbNode.database {
                let views = node.viewIDs.compactMap { model.registry.view($0).view }.sorted { $0.sortKey < $1.sortKey }
                if let view = views.first(where: { $0.id == activeViewID }) ?? views.first {
                    content(block: block, db: db, views: views, view: view)
                } else {
                    missing("This database has no views.")
                }
            } else {
                missing("The source database was deleted.")
            }
        } else {
            missing("No access to this database.")
        }
    }

    private func missing(_ text: String) -> some View {
        Text(text).foregroundStyle(Theme.secondary).padding(.vertical, DS.Space.md)
    }

    @ViewBuilder
    private func content(block: Block, db: Database, views: [DatabaseView], view: DatabaseView) -> some View {
        let engine = model.queryCache.queryEngine
        let activeSearch = searching ? search : nil
        let result = model.queryCache.run(view, search: activeSearch)
        let nested = !fullPage && isInsideToggle(block)
        let ctx = DBContext(block: block, db: db, view: view, engine: engine, result: result, model: model,
                            locked: db.locked == true || model.store.blocks[model.store.containingPage(of: blockID) ?? ""]?.props.format?.locked == true,
                            search: activeSearch)
        VStack(alignment: .leading, spacing: 6) {
            // Under a toggle the toggle's own text already names the database, and the filter / sort chips
            // would only add noise: hide both there (the toolbar icons still light up when rules are active).
            if !fullPage, block.type == .databaseInline, !nested {
                DatabaseTitleField(db: db, linked: db.blockID != block.id,
                                   locked: ctx.locked)
            }
            header(ctx, views: views)
            if !nested, (view.filter?.isEmpty == false) || (view.sorts?.isEmpty == false) {
                ActiveRulesBar(ctx: ctx, showFilter: $showFilter, showSort: $showSort)
            }
            Rectangle().fill(Theme.gridLine).frame(height: 1)
            if fullPage {
                layout(ctx)
            } else {
                // Inline databases fill in one per frame, so a page with several big boards or calendars
                // shows up at once instead of freezing while every card is built (Notion loads them progressively too).
                DeferredContent(id: blockID) { layout(ctx) }
            }
        }
        .padding(.vertical, DS.Space.xs)
        .onChange(of: model.dbSearchRequest) { _, _ in
            // ⌘F on a full-page database searches its rows (Notion behaviour).
            guard fullPage else { return }
            searching = true
            searchFocused = true
        }
    }

    @ViewBuilder
    private func layout(_ ctx: DBContext) -> some View {
        switch ctx.view.type {
        case .board: BoardLayout(ctx: ctx)
        case .list: ListLayout(ctx: ctx)
        case .gallery: GalleryLayout(ctx: ctx)
        case .calendar: CalendarLayout(ctx: ctx)
        case .timeline: TimelineLayout(ctx: ctx)
        case .chart: ChartLayout(ctx: ctx)
        case .dashboard: DashboardLayout(ctx: ctx)
        case .form: FormLayout(ctx: ctx)
        case .map: MapLayout(ctx: ctx)
        default: TableLayout(ctx: ctx)
        }
    }

    // MARK: Header (view tabs + toolbar)

    private func header(_ ctx: DBContext, views: [DatabaseView]) -> some View {
        // One row when the tabs and the toolbar fit side by side; otherwise the toolbar drops below the tabs
        // so tab names are never squeezed out (the tab strip scrolls only if it alone is too wide).
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) {
                viewTabs(ctx, views: views)
                Spacer(minLength: 8)
                if ctx.view.type != .dashboard { toolbar(ctx) }
            }
            VStack(alignment: .leading, spacing: 2) {
                ScrollView(.horizontal, showsIndicators: false) {
                    viewTabs(ctx, views: views).padding(.vertical, 1)
                }
                if ctx.view.type != .dashboard {
                    HStack(spacing: 0) {
                        Spacer(minLength: 0)
                        toolbar(ctx)
                    }
                }
            }
        }
        .font(DS.Text.ui())
    }

    private func viewTabs(_ ctx: DBContext, views: [DatabaseView]) -> some View {
        HStack(spacing: 2) {
            ForEach(views) { v in tab(v, active: v.id == ctx.view.id, ctx: ctx, count: views.count) }
            if !ctx.locked {
                Menu {
                    ForEach(ViewType.available, id: \.self) { t in
                        Button(t.displayName, systemImage: t.symbol) {
                            if let id = model.store.addView(to: blockID, type: t) { activeViewID = id }
                        }
                    }
                } label: { ToolbarIcon("plus", size: 12) }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .frame(width: 24, height: 24)
                .hoverHighlight(opacity: 0.065)
                .help("Add a view")
            }
        }
    }

    private func commitRename(_ id: RecordID) {
        guard renamingView == id else { return }
        let name = viewName.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty { model.store.updateView(id, name: "Rename view") { $0.name = name } }
        renamingView = nil
    }

    /// True when the block sits (at any depth) under a toggle list or a toggle heading.
    private func isInsideToggle(_ block: Block) -> Bool {
        var parent = block.parent
        var depth = 0
        while let id = parent.id, depth < 32, let p = model.store.blocks[id] {
            if p.type == .toggle || (p.type.isHeading && p.props.toggleable == true) { return true }
            parent = p.parent
            depth += 1
        }
        return false
    }

    @ViewBuilder
    private func tab(_ v: DatabaseView, active: Bool, ctx: DBContext, count: Int) -> some View {
        if renamingView == v.id {
            TextField("View name", text: $viewName)
                .textFieldStyle(.roundedBorder)
                .frame(width: 140)
                .focused($renameFocused)
                .onAppear { renameFocused = true }
                .onSubmit { commitRename(v.id) }
                .onKeyPress(.escape) { renamingView = nil; return .handled }
                .onChange(of: renameFocused) { _, f in if !f { commitRename(v.id) } }
        } else {
            // Notion: views are pills — the active one filled, the others quiet until hovered.
            Button { withAnimation(.easeOut(duration: 0.12)) { activeViewID = v.id } } label: {
                HStack(spacing: 5) {
                    Image(systemName: v.type.symbol).font(DS.Text.small())
                    Text(v.name).font(.system(size: 14, weight: active ? .medium : .regular)).lineLimit(1)
                }
                .padding(.horizontal, DS.Space.xs)
                .foregroundStyle(active ? Theme.primary : Theme.secondary)
            }
            .buttonStyle(.quiet(padding: 4, cornerRadius: 14, minSize: 26, selected: active))
            .fixedSize(horizontal: true, vertical: false)
            .help(ctx.locked ? v.name : "\(v.name) — double-click to rename")
            .simultaneousGesture(TapGesture(count: 2).onEnded {
                guard !ctx.locked else { return }
                viewName = v.name
                renamingView = v.id
            })
            .contextMenu {
                if !ctx.locked {
                    Button("Rename", systemImage: "pencil") { viewName = v.name; renamingView = v.id }
                    Menu("Layout") {
                        ForEach(ViewType.available.filter { $0 != .dashboard && v.type != .dashboard }, id: \.self) { t in
                            Button(t.displayName, systemImage: t.symbol) { model.store.updateView(v.id, name: "Change layout") { $0.type = t } }
                        }
                    }
                    Button("Duplicate view", systemImage: "plus.square.on.square") {
                        if let id = model.store.duplicateView(v.id) { activeViewID = id }
                    }
                    if count > 1 {
                        Button("Delete view", systemImage: "trash", role: .destructive) {
                            model.store.deleteView(v.id)
                            if activeViewID == v.id { activeViewID = nil }
                        }
                    }
                }
                Button("Copy link to view", systemImage: "link") { Clipboard.copy("based://view/" + v.id) }
            }
        }
    }

    private func toolbar(_ ctx: DBContext) -> some View {
        HStack(spacing: 1) {
            Button { showFilter.toggle() } label: {
                ToolbarIcon("line.3.horizontal.decrease", active: ctx.view.filter?.isEmpty == false)
            }
            .buttonStyle(.quiet)
            .help("Filter")
            .panelPopover(isPresented: $showFilter) { FilterEditor(ctx: ctx) }
            Button { showSort.toggle() } label: {
                ToolbarIcon("arrow.up.arrow.down", active: ctx.view.sorts?.isEmpty == false)
            }
            .buttonStyle(.quiet)
            .help("Sort")
            .panelPopover(isPresented: $showSort) { SortEditor(ctx: ctx) }
            if searching {
                HStack(spacing: 4) {
                    ToolbarIcon("magnifyingglass", size: 12)
                    TextField("Type to search…", text: $search)
                        .textFieldStyle(.plain)
                        .font(DS.Text.body())
                        .frame(width: 150)
                        .focused($searchFocused)
                        .onAppear { searchFocused = true }
                        .onKeyPress(.escape) { searching = false; search = ""; return .handled }
                        .accessibilityIdentifier("db.search")
                    Button { searching = false; search = "" } label: { ToolbarIcon("xmark", size: 10) }
                        .buttonStyle(.quiet(padding: 2, minSize: 18))
                }
                .padding(.leading, DS.Space.sm).padding(.trailing, DS.Space.xxs)
                .frame(height: 26)
                .background(RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous).fill(Theme.primary.opacity(0.055)))
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            } else {
                Button { withAnimation(.easeOut(duration: 0.15)) { searching = true } } label: { ToolbarIcon("magnifyingglass") }
                    .buttonStyle(.quiet)
                    .help("Search (⌘F)")
                    .accessibilityIdentifier("db.searchButton")
            }
            if !fullPage, let source = expandTarget(ctx) {
                Button { model.open(source, mode: .fullPage) } label: { ToolbarIcon("arrow.up.left.and.arrow.down.right", size: 12) }
                    .buttonStyle(.quiet)
                    .help("Open as full page (⌘-click: new tab)")
            }
            Button { showSettings.toggle() } label: { ToolbarIcon("slider.horizontal.3") }
                .buttonStyle(.quiet)
                .help("View settings")
                .panelPopover(isPresented: $showSettings) { ViewSettingsView(ctx: ctx) }
            if !ctx.locked {
                NewRowButton(ctx: ctx).padding(.leading, DS.Space.sm)
            }
        }
    }

    /// The full-page database behind an inline / linked view, if it has one (Notion's ↗ "open as page").
    private func expandTarget(_ ctx: DBContext) -> RecordID? {
        if ctx.block.type == .databasePage { return nil }
        if let src = model.store.blocks[ctx.db.blockID], src.type == .databasePage { return src.id }
        return nil
    }
}

/// "New ⌄" button with templates.
struct NewRowButton: View {
    let ctx: DBContext

    var body: some View {
        let templates = ctx.store.templates(of: ctx.db.id)
        PrimarySplitButton(title: "New") {
            let id = ctx.addRow()
            if ctx.view.type != .table { ctx.open(id) }
        } menu: {
            Section("Templates") {
                ForEach(templates, id: \.id) { t in
                    Button {
                        let id = ctx.addRow(template: t.id)
                        ctx.open(id)
                    } label: {
                        Label(ctx.store.title(of: t.id), systemImage: t.id == ctx.db.defaultTemplateID ? "star.fill" : "doc")
                    }
                }
                Button("Empty page", systemImage: "doc") { ctx.open(ctx.addRowWithoutTemplate()) }
            }
            Divider()
            Button("New template", systemImage: "plus") {
                let id = ctx.store.addTemplate(to: ctx.db.id)
                ctx.model.open(id, mode: .centerPeek)
            }
            if !templates.isEmpty {
                Menu("Set default template") {
                    Button("Empty page") { ctx.store.updateDatabase(ctx.db.id, name: "Default template") { $0.defaultTemplateID = nil } }
                    ForEach(templates, id: \.id) { t in
                        Button(ctx.store.title(of: t.id)) {
                            ctx.store.updateDatabase(ctx.db.id, name: "Default template") { $0.defaultTemplateID = t.id }
                        }
                    }
                }
                Menu("Edit template") {
                    ForEach(templates, id: \.id) { t in
                        Button(ctx.store.title(of: t.id)) { ctx.model.open(t.id, mode: .centerPeek) }
                    }
                }
            }
        }
    }
}

extension DBContext {
    func addRowWithoutTemplate() -> RecordID {
        store.createPage(in: .database(db.id), values: prefill(), name: "New row")
    }
}

/// Editable title of an inline database.
struct DatabaseTitleField: View {
    let db: Database
    var linked = false
    var locked = false
    var size: CGFloat = 20
    @Environment(AppModel.self) private var model
    @State private var draft = ""

    var body: some View {
        HStack(spacing: 6) {
            if linked { Image(systemName: "arrow.up.right").font(.system(size: size * 0.6)).foregroundStyle(Theme.secondary) }
            if locked {
                Text(db.title.plainText.isEmpty ? "Untitled" : db.title.plainText)
            } else {
                TextField("Untitled", text: $draft)
                    .textFieldStyle(.plain)
                    .onChange(of: draft) { _, v in
                        if v != db.title.plainText { model.store.setDatabaseTitle(db.id, RichText(v)) }
                    }
            }
        }
        .font(.system(size: size, weight: .semibold))
        .onAppear { draft = db.title.plainText }
        .onChange(of: db.title.plainText) { _, v in if v != draft { draft = v } }
    }
}

/// Chips summarising active sorts / filters under the toolbar.
struct ActiveRulesBar: View {
    let ctx: DBContext
    @Binding var showFilter: Bool
    @Binding var showSort: Bool

    var body: some View {
        // At most two chips (sort, filter): several rules collapse into a count so the bar stays one quiet line.
        HStack(spacing: 6) {
            if let sorts = ctx.view.sorts, !sorts.isEmpty {
                chip(sorts.count == 1 ? sortLabel(sorts[0]) : "\(sorts.count) sorts", symbol: "arrow.up.arrow.down") { showSort = true }
            }
            if let f = ctx.view.filter, !f.items.isEmpty {
                chip(f.items.count == 1 ? filterLabel(f.items[0]) : "\(f.items.count) filters", symbol: "line.3.horizontal.decrease") { showFilter = true }
            }
            Spacer()
        }
        .font(DS.Text.small())
    }

    private func chip(_ text: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(text, systemImage: symbol)
                .lineLimit(1)
                .frame(maxWidth: 260, alignment: .leading)
                .padding(.horizontal, DS.Space.md).padding(.vertical, 3)
                .background(Capsule().fill(Theme.accentBlue.opacity(0.12)))
                .foregroundStyle(Theme.accentBlue)
        }
        .buttonStyle(.plain)
        .hoverHighlight(cornerRadius: DS.Radius.panel, opacity: 0.06)
        .help(text)
    }

    private func sortLabel(_ s: SortRule) -> String {
        let name = ctx.db.property(s.propertyID)?.name ?? "Name"
        return "\(name) \(s.ascending ? "↑" : "↓")"
    }

    private func filterLabel(_ item: FilterItem) -> String {
        switch item {
        case .group(let g): return "\(g.items.count) rules"
        case .unknown: return "Filter from a newer version"
        case .condition(let c):
            let p = ctx.db.property(c.propertyID)
            let v = c.value.map { FilterValueText.describe($0, p, ctx.store) } ?? ""
            return [p?.name ?? "?", c.op.displayName.lowercased(), v].filter { !$0.isEmpty }.joined(separator: " ")
        }
    }
}

enum FilterValueText {
    @MainActor
    static func describe(_ v: FilterValue, _ p: PropertySchema?, _ store: WorkspaceStore) -> String {
        switch v {
        case .text(let t): return t
        case .number(let n): return NumberFormatting.plain(n)
        case .bool(let b): return b ? "checked" : "unchecked"
        case .date(let d): return d.formatted(date: .abbreviated, time: .omitted)
        case .relative(let r): return r.displayName
        case .options(let ids):
            if p?.type == .relation { return ids.map { store.title(of: $0) }.joined(separator: ", ") }
            return ids.map { p?.option($0)?.name ?? $0 }.joined(separator: ", ")
        }
    }
}

extension RelativeDate {
    var displayName: String {
        switch self {
        case .today: return "Today"
        case .tomorrow: return "Tomorrow"
        case .yesterday: return "Yesterday"
        case .pastWeek: return "Past week"
        case .nextWeek: return "Next week"
        case .pastMonth: return "Past month"
        case .nextMonth: return "Next month"
        case .pastYear: return "Past year"
        case .nextYear: return "Next year"
        case .unknown: return "Needs a newer version"
        }
    }
}
/// Builds heavy content a frame after the page appears, one block at a time, holding the last known height meanwhile.
struct DeferredContent<Content: View>: View {
    let id: RecordID
    @ViewBuilder let content: () -> Content
    @State private var ready = false

    var body: some View {
        if ready {
            content()
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { DeferredRender.heights[id] = $0 }
        } else {
            Color.clear
                .frame(height: DeferredRender.heights[id] ?? 120)
                .onAppear { DeferredRender.enqueue { ready = true } }
        }
    }
}

/// Hands out one "render now" turn per run-loop pass so each deferred block gets its own frame.
@MainActor
enum DeferredRender {
    static var heights: [RecordID: CGFloat] = [:]
    private static var queue: [() -> Void] = []
    private static var scheduled = false

    static func enqueue(_ work: @escaping () -> Void) {
        queue.append(work)
        schedule()
    }

    private static func schedule() {
        guard !scheduled, !queue.isEmpty else { return }
        scheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.005) {
            scheduled = false
            guard !queue.isEmpty else { return }
            queue.removeFirst()()
            schedule()
        }
    }
}
