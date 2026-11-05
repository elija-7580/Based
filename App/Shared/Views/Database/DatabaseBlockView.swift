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

    var store: WorkspaceStore { model.store }
    var visibleProperties: [PropertySchema] {
        view.visiblePropertyIDs(in: db).compactMap { db.property($0) ?? ($0 == db.titleProperty.id ? db.titleProperty : nil) }
    }
    /// Non-title properties shown on cards / list rows.
    var cardProperties: [PropertySchema] { visibleProperties.filter { $0.type != .title } }

    func open(_ rowID: RecordID) { model.open(rowID, mode: view.openIn ?? .sidePeek) }

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
        Text(text).foregroundStyle(Theme.secondary).padding(.vertical, 8)
    }

    @ViewBuilder
    private func content(block: Block, db: Database, views: [DatabaseView], view: DatabaseView) -> some View {
        let engine = QueryEngine(store: model.store)
        let result = engine.run(view, search: searching ? search : nil)
        let ctx = DBContext(block: block, db: db, view: view, engine: engine, result: result, model: model,
                            locked: db.locked == true || model.store.blocks[model.store.containingPage(of: blockID) ?? ""]?.props.format?.locked == true)
        VStack(alignment: .leading, spacing: 6) {
            if !fullPage, block.type == .databaseInline {
                DatabaseTitleField(db: db, linked: db.blockID != block.id,
                                   locked: ctx.locked)
            }
            header(ctx, views: views)
            if (view.filter?.isEmpty == false) || (view.sorts?.isEmpty == false) {
                ActiveRulesBar(ctx: ctx, showFilter: $showFilter, showSort: $showSort)
            }
            Divider()
            layout(ctx)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func layout(_ ctx: DBContext) -> some View {
        switch ctx.view.type {
        case .board: BoardLayout(ctx: ctx)
        case .list: ListLayout(ctx: ctx)
        case .gallery: GalleryLayout(ctx: ctx)
        case .calendar: CalendarLayout(ctx: ctx)
        case .timeline: TimelineLayout(ctx: ctx)
        default: TableLayout(ctx: ctx)
        }
    }

    // MARK: Header (view tabs + toolbar)

    private func header(_ ctx: DBContext, views: [DatabaseView]) -> some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(views) { v in tab(v, active: v.id == ctx.view.id, ctx: ctx, count: views.count) }
                    if !ctx.locked {
                        Menu {
                            ForEach(ViewType.available, id: \.self) { t in
                                Button(t.displayName, systemImage: t.symbol) {
                                    if let id = model.store.addView(to: blockID, type: t) { activeViewID = id }
                                }
                            }
                        } label: { Image(systemName: "plus").foregroundStyle(Theme.secondary) }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                    }
                }
            }
            Spacer(minLength: 8)
            toolbar(ctx)
        }
        .font(.system(size: 14))
    }

    @ViewBuilder
    private func tab(_ v: DatabaseView, active: Bool, ctx: DBContext, count: Int) -> some View {
        if renamingView == v.id {
            TextField("View name", text: $viewName)
                .textFieldStyle(.roundedBorder)
                .frame(width: 140)
                .onSubmit {
                    let name = viewName.trimmingCharacters(in: .whitespaces)
                    if !name.isEmpty { model.store.updateView(v.id, name: "Rename view") { $0.name = name } }
                    renamingView = nil
                }
        } else {
            Button { activeViewID = v.id } label: {
                Label(v.name, systemImage: v.type.symbol)
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .foregroundStyle(active ? Theme.primary : Theme.secondary)
                    .overlay(alignment: .bottom) { if active { Rectangle().fill(Theme.primary).frame(height: 2) } }
            }
            .buttonStyle(.plain)
            .contextMenu {
                if !ctx.locked {
                    Button("Rename", systemImage: "pencil") { viewName = v.name; renamingView = v.id }
                    Menu("Layout") {
                        ForEach(ViewType.available, id: \.self) { t in
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
        HStack(spacing: 10) {
            Button { showFilter.toggle() } label: {
                Image(systemName: "line.3.horizontal.decrease")
                    .foregroundStyle(ctx.view.filter?.isEmpty == false ? Color.accentColor : Theme.secondary)
            }
            .buttonStyle(.plain)
            .help("Filter")
            .popover(isPresented: $showFilter) { FilterEditor(ctx: ctx) }
            Button { showSort.toggle() } label: {
                Image(systemName: "arrow.up.arrow.down")
                    .foregroundStyle(ctx.view.sorts?.isEmpty == false ? Color.accentColor : Theme.secondary)
            }
            .buttonStyle(.plain)
            .help("Sort")
            .popover(isPresented: $showSort) { SortEditor(ctx: ctx) }
            if searching {
                TextField("Type to search…", text: $search)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 160)
                    .onSubmit {}
                Button { searching = false; search = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(Theme.secondary)
            } else {
                Button { searching = true } label: { Image(systemName: "magnifyingglass").foregroundStyle(Theme.secondary) }
                    .buttonStyle(.plain)
                    .help("Search")
            }
            Button { showSettings.toggle() } label: { Image(systemName: "ellipsis").foregroundStyle(Theme.secondary) }
                .buttonStyle(.plain)
                .help("View settings")
                .popover(isPresented: $showSettings) { ViewSettingsView(ctx: ctx) }
            if !ctx.locked {
                NewRowButton(ctx: ctx)
            }
        }
    }
}

/// "New ⌄" button with templates.
struct NewRowButton: View {
    let ctx: DBContext

    var body: some View {
        let templates = ctx.store.templates(of: ctx.db.id)
        Menu {
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
        } label: {
            Text("New")
        } primaryAction: {
            let id = ctx.addRow()
            if ctx.view.type != .table { ctx.open(id) }
        }
        .menuStyle(.button)
        .buttonStyle(.bordered)
        .fixedSize()
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
        HStack(spacing: 6) {
            if let sorts = ctx.view.sorts, !sorts.isEmpty {
                chip(sorts.count == 1 ? sortLabel(sorts[0]) : "\(sorts.count) sorts", symbol: "arrow.up.arrow.down") { showSort = true }
            }
            if let f = ctx.view.filter {
                ForEach(Array(f.items.enumerated()), id: \.offset) { _, item in
                    chip(filterLabel(item), symbol: "line.3.horizontal.decrease") { showFilter = true }
                }
            }
            Spacer()
        }
        .font(.system(size: 12))
    }

    private func chip(_ text: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(text, systemImage: symbol)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(Color.accentColor.opacity(0.12)))
                .foregroundStyle(Color.accentColor)
        }
        .buttonStyle(.plain)
    }

    private func sortLabel(_ s: SortRule) -> String {
        let name = ctx.db.property(s.propertyID)?.name ?? "Name"
        return "\(name) \(s.ascending ? "↑" : "↓")"
    }

    private func filterLabel(_ item: FilterItem) -> String {
        switch item {
        case .group(let g): return "\(g.items.count) rules"
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
        }
    }
}