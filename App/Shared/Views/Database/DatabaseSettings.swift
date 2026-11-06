import SwiftUI
import BasedCore

// MARK: - Filters

struct FilterEditor: View {
    let ctx: DBContext

    var body: some View {
        let group = ctx.view.filter ?? FilterGroup()
        VStack(alignment: .leading, spacing: 8) {
            if group.items.isEmpty {
                Text("No filters applied to this view").foregroundStyle(Theme.secondary)
            }
            FilterGroupEditor(ctx: ctx, group: group, depth: 0) { save($0) }
            if !group.items.isEmpty {
                Button("Delete all filters", role: .destructive) { save(FilterGroup()) }.buttonStyle(.plain).foregroundStyle(.red)
            }
        }
        .padding(12)
        .frame(minWidth: 460)
    }

    private func save(_ g: FilterGroup) {
        ctx.store.updateView(ctx.view.id, name: "Filter") { $0.filter = g.isEmpty ? nil : g }
    }
}

struct FilterGroupEditor: View {
    let ctx: DBContext
    let group: FilterGroup
    let depth: Int
    let onChange: (FilterGroup) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(group.items.enumerated()), id: \.offset) { i, item in
                HStack(alignment: .top, spacing: 6) {
                    combinatorLabel(i).frame(width: 64, alignment: .leading)
                    switch item {
                    case .condition(let c):
                        FilterConditionRow(ctx: ctx, condition: c) { replace(i, $0.map(FilterItem.condition)) }
                    case .group(let g):
                        FilterGroupEditor(ctx: ctx, group: g, depth: depth + 1) { ng in replace(i, ng.isEmpty ? nil : .group(ng)) }
                            .padding(8)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.04)))
                    }
                }
            }
            HStack {
                Menu("Add filter rule") {
                    ForEach(ctx.db.properties) { p in
                        Button(p.name, systemImage: p.type.symbol) { append(.condition(FilterCondition(propertyID: p.id, op: FilterOp.ops(for: p.type).first ?? .contains))) }
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                if depth < 2 {
                    Button("Add filter group") {
                        let first = ctx.db.titleProperty
                        append(.group(FilterGroup(combinator: .and, items: [.condition(FilterCondition(propertyID: first.id, op: .contains))])))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.secondary)
                }
            }
            .font(.system(size: 13))
        }
    }

    @ViewBuilder
    private func combinatorLabel(_ i: Int) -> some View {
        if i == 0 {
            Text("Where").foregroundStyle(Theme.secondary)
        } else if i == 1 {
            Picker("", selection: Binding(get: { group.combinator }, set: { c in var g = group; g.combinator = c; onChange(g) })) {
                Text("And").tag(Combinator.and)
                Text("Or").tag(Combinator.or)
            }
            .labelsHidden()
        } else {
            Text(group.combinator == .and ? "And" : "Or").foregroundStyle(Theme.secondary)
        }
    }

    private func replace(_ i: Int, _ item: FilterItem?) {
        var g = group
        if let item { g.items[i] = item } else { g.items.remove(at: i) }
        onChange(g)
    }

    private func append(_ item: FilterItem) {
        var g = group
        g.items.append(item)
        onChange(g)
    }
}

struct FilterConditionRow: View {
    let ctx: DBContext
    let condition: FilterCondition
    let onChange: (FilterCondition?) -> Void

    var body: some View {
        let p = ctx.db.property(condition.propertyID)
        HStack(spacing: 6) {
            Menu(p?.name ?? "Property") {
                ForEach(ctx.db.properties) { np in
                    Button(np.name, systemImage: np.type.symbol) {
                        onChange(FilterCondition(id: condition.id, propertyID: np.id, op: FilterOp.ops(for: np.type).first ?? .contains))
                    }
                }
            }
            .fixedSize()
            Menu(condition.op.displayName) {
                ForEach(FilterOp.ops(for: p?.type ?? .text), id: \.self) { op in
                    Button(op.displayName) { var c = condition; c.op = op; if !op.needsValue { c.value = nil }; onChange(c) }
                }
            }
            .fixedSize()
            if condition.op.needsValue, let p {
                FilterValueField(ctx: ctx, property: p, value: condition.value) { v in var c = condition; c.value = v; onChange(c) }
            }
            Spacer(minLength: 0)
            Button { onChange(nil) } label: { Image(systemName: "trash") }.buttonStyle(.plain).foregroundStyle(Theme.secondary)
        }
        .font(.system(size: 13))
    }
}

struct FilterValueField: View {
    let ctx: DBContext
    let property: PropertySchema
    let value: FilterValue?
    let onChange: (FilterValue?) -> Void
    @State private var text = ""

    var body: some View {
        Group {
            switch property.type {
            case .select, .multiSelect, .status:
                let selected: [String] = { if case .options(let ids)? = value { return ids }; return [] }()
                Menu(selected.isEmpty ? "Select…" : selected.compactMap { property.option($0)?.name }.joined(separator: ", ")) {
                    ForEach(property.options ?? []) { o in
                        Button {
                            var ids = selected
                            if let i = ids.firstIndex(of: o.id) { ids.remove(at: i) } else { ids.append(o.id) }
                            onChange(ids.isEmpty ? nil : .options(ids))
                        } label: {
                            Label(o.name, systemImage: selected.contains(o.id) ? "checkmark" : "circle.fill")
                        }
                    }
                }
                .fixedSize()
            case .relation:
                let selected: [String] = { if case .options(let ids)? = value { return ids }; return [] }()
                Menu(selected.isEmpty ? "Select pages…" : selected.map { ctx.store.title(of: $0) }.joined(separator: ", ")) {
                    ForEach(property.relation.map { ctx.store.rows(of: $0.databaseID) }?.prefix(60).map { $0 } ?? [], id: \.id) { r in
                        Button {
                            var ids = selected
                            if let i = ids.firstIndex(of: r.id) { ids.remove(at: i) } else { ids.append(r.id) }
                            onChange(ids.isEmpty ? nil : .options(ids))
                        } label: {
                            Label(ctx.store.title(of: r.id), systemImage: selected.contains(r.id) ? "checkmark" : "doc")
                        }
                    }
                }
                .fixedSize()
            case .checkbox:
                Picker("", selection: Binding(get: { if case .bool(let b)? = value { return b }; return true }, set: { onChange(.bool($0)) })) {
                    Text("Checked").tag(true)
                    Text("Unchecked").tag(false)
                }
                .labelsHidden()
                .fixedSize()
            case .date, .createdTime, .lastEditedTime:
                dateField
            case .number, .uniqueID:
                TextField("Value", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 100)
                    .onChange(of: text) { _, v in onChange(Double(v).map(FilterValue.number) ?? (v.isEmpty ? nil : value)) }
            default:
                TextField("Value", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 140)
                    .onChange(of: text) { _, v in onChange(v.isEmpty ? nil : .text(v)) }
            }
        }
        .onAppear {
            switch value {
            case .text(let t)?: text = t
            case .number(let n)?: text = NumberFormatting.plain(n)
            default: break
            }
        }
    }

    @ViewBuilder
    private var dateField: some View {
        let label: String = {
            switch value {
            case .relative(let r)?: return r.displayName
            case .date(let d)?: return d.formatted(date: .abbreviated, time: .omitted)
            default: return "Select date…"
            }
        }()
        Menu(label) {
            ForEach(RelativeDate.allCases, id: \.self) { r in Button(r.displayName) { onChange(.relative(r)) } }
            Divider()
            Button("Exact date: today") { onChange(.date(Calendar.current.startOfDay(for: Date()))) }
        }
        .fixedSize()
        if case .date(let d)? = value {
            DatePicker("", selection: Binding(get: { d }, set: { onChange(.date(Calendar.current.startOfDay(for: $0))) }), displayedComponents: [.date])
                .labelsHidden()
        }
    }
}

// MARK: - Sorts

struct SortEditor: View {
    let ctx: DBContext

    var body: some View {
        let sorts = ctx.view.sorts ?? []
        VStack(alignment: .leading, spacing: 8) {
            if sorts.isEmpty { Text("No sorts applied to this view").foregroundStyle(Theme.secondary) }
            ForEach(Array(sorts.enumerated()), id: \.offset) { i, s in
                HStack {
                    Menu(ctx.db.property(s.propertyID)?.name ?? "Property") {
                        ForEach(ctx.db.properties) { p in
                            Button(p.name, systemImage: p.type.symbol) { var l = sorts; l[i].propertyID = p.id; save(l) }
                        }
                    }
                    .fixedSize()
                    Picker("", selection: Binding(get: { s.ascending }, set: { var l = sorts; l[i].ascending = $0; save(l) })) {
                        Text("Ascending").tag(true)
                        Text("Descending").tag(false)
                    }
                    .labelsHidden()
                    .fixedSize()
                    Spacer()
                    if i > 0 {
                        Button { var l = sorts; l.swapAt(i, i - 1); save(l) } label: { Image(systemName: "arrow.up") }.buttonStyle(.plain)
                    }
                    Button { var l = sorts; l.remove(at: i); save(l) } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                }
            }
            HStack {
                Menu("Add sort") {
                    ForEach(ctx.db.properties.filter { p in !sorts.contains { $0.propertyID == p.id } }) { p in
                        Button(p.name, systemImage: p.type.symbol) { save(sorts + [SortRule(propertyID: p.id)]) }
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                if !sorts.isEmpty {
                    Button("Delete sort", role: .destructive) { save([]) }.buttonStyle(.plain).foregroundStyle(.red)
                }
            }
        }
        .font(.system(size: 13))
        .padding(12)
        .frame(minWidth: 340)
    }

    private func save(_ l: [SortRule]) {
        ctx.store.updateView(ctx.view.id, name: "Sort") { $0.sorts = l.isEmpty ? nil : l }
    }
}

// MARK: - View settings

struct ViewSettingsView: View {
    let ctx: DBContext
    @State private var name = ""

    private var store: WorkspaceStore { ctx.store }
    private var v: DatabaseView { ctx.view }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                TextField("View name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { if !name.isEmpty { update("Rename view") { $0.name = name } } }
                section("Layout") {
                    Picker("Layout", selection: Binding(get: { v.type }, set: { t in update("Change layout") { $0.type = t } })) {
                        ForEach(ViewType.available, id: \.self) { Label($0.displayName, systemImage: $0.symbol).tag($0) }
                    }
                }
                section("Properties") { propertiesList }
                section("Group") { grouping }
                if v.type == .calendar || v.type == .timeline {
                    section(v.type == .calendar ? "Show calendar by" : "Show timeline by") {
                        let dates = ctx.db.properties.filter { [.date, .createdTime, .lastEditedTime].contains($0.type) }
                        Picker("Date", selection: Binding(get: { ctx.dateProperty?.id ?? "" }, set: { id in update("Date property") { $0.datePropertyID = id } })) {
                            ForEach(dates) { Text($0.name).tag($0.id) }
                        }
                        if v.type == .timeline {
                            Picker("End date", selection: Binding(get: { v.endDatePropertyID ?? "" }, set: { id in update("End date") { $0.endDatePropertyID = id.isEmpty ? nil : id } })) {
                                Text("Same as start").tag("")
                                ForEach(dates) { Text($0.name).tag($0.id) }
                            }
                        }
                    }
                }
                if v.type == .chart {
                    section("Chart") { chartSettings }
                }
                if v.type == .map {
                    section("Map") {
                        let places = ctx.db.properties.filter { $0.type == .place }
                        Picker("Map by", selection: Binding(get: { v.mapPropertyID ?? places.first?.id ?? "" }, set: { id in update("Map by") { $0.mapPropertyID = id.isEmpty ? nil : id } })) {
                            if places.isEmpty { Text("No Place property").tag("") }
                            ForEach(places) { Text($0.name).tag($0.id) }
                        }
                        Picker("Height", selection: Binding(get: { v.mapHeight ?? "medium" }, set: { h in update("Map height") { $0.mapHeight = h } })) {
                            Text("Small").tag("small"); Text("Medium").tag("medium"); Text("Large").tag("large"); Text("Extra large").tag("extra_large")
                        }
                        if places.isEmpty {
                            Button("Add a Place property") {
                                if let id = ctx.store.addProperty(to: ctx.db.id, name: "Place", type: .place) { update("Map by") { $0.mapPropertyID = id } }
                            }
                        }
                    }
                }
                if v.type == .board || v.type == .gallery {
                    section("Cards") {
                        Picker("Card preview", selection: Binding(get: { coverKey(v.cardCover ?? (v.type == .gallery ? .pageContent : CardCover.none)) },
                                                                  set: { k in update("Card preview") { $0.cardCover = cover(fromKey: k) } })) {
                            Text("None").tag("none")
                            Text("Page cover").tag("cover")
                            Text("Page content").tag("content")
                            ForEach(ctx.db.properties.filter { $0.type == .files }) { Text($0.name).tag("p:" + $0.id) }
                        }
                        Picker("Card size", selection: Binding(get: { v.cardSize ?? .medium }, set: { s in update("Card size") { $0.cardSize = s } })) {
                            ForEach(CardSize.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                        }
                    }
                }
                section("Options") {
                    Toggle(v.type == .table ? "Wrap all columns" : "Wrap all properties", isOn: Binding(get: { v.wrapCells == true }, set: { on in update("Wrap") { $0.wrapCells = on } }))
                    Toggle("Show page icon", isOn: Binding(get: { v.showIcons != false }, set: { on in update("Icons") { $0.showIcons = on ? nil : false } }))
                    Picker("Open pages in", selection: Binding(get: { v.openIn ?? .sidePeek }, set: { m in update("Open in") { $0.openIn = m } })) {
                        ForEach(OpenMode.allCases, id: \.self) { Text($0.displayName).tag($0) }
                    }
                    Picker("Load limit", selection: Binding(get: { v.loadLimit ?? 50 }, set: { n in update("Load limit") { $0.loadLimit = n } })) {
                        ForEach([10, 25, 50, 100], id: \.self) { Text("\($0) pages").tag($0) }
                    }
                    Toggle("Lock database", isOn: Binding(get: { ctx.db.locked == true }, set: { on in store.updateDatabase(ctx.db.id, name: "Lock database") { $0.locked = on ? true : nil } }))
                }
                HStack {
                    Button("Duplicate view") { _ = store.duplicateView(v.id) }
                    Spacer()
                    if store.views(forBlock: ctx.block.id).count > 1 {
                        Button("Delete view", role: .destructive) { store.deleteView(v.id) }
                    }
                }
                if ctx.block.id == ctx.db.blockID {
                    Button("Export as CSV…") { ctx.model.exportRequest = AppModel.ExportRequest(pageID: ctx.block.id) }
                }
            }
            .padding(12)
        }
        .font(.system(size: 13))
        .frame(width: 340, height: 520)
        .onAppear { name = v.name }
    }

    private func update(_ name: String, _ f: @escaping (inout DatabaseView) -> Void) { store.updateView(v.id, name: name, f) }

    // MARK: Chart

    private var chart: ChartConfig { v.chart ?? ChartConfig() }
    private func updateChart(_ name: String, _ f: @escaping (inout ChartConfig) -> Void) {
        update(name) { view in var c = view.chart ?? ChartConfig(); f(&c); view.chart = c }
    }

    @ViewBuilder
    private var chartSettings: some View {
        let categorical = ctx.db.properties.filter { [.select, .status, .multiSelect, .checkbox, .date, .createdTime, .lastEditedTime, .person, .relation, .text, .title].contains($0.type) }
        let numeric = ctx.db.properties.filter { [.number, .formula, .rollup].contains($0.type) }
        Picker("Chart type", selection: Binding(get: { chart.kind }, set: { k in updateChart("Chart type") { $0.kind = k } })) {
            ForEach(ChartConfig.Kind.allCases, id: \.self) { Text($0.displayName).tag($0) }
        }
        .accessibilityIdentifier("chart.kind")
        Picker(chart.kind == .pie || chart.kind == .donut ? "Slices" : "X axis", selection: Binding(get: { chart.xPropertyID ?? "" }, set: { id in updateChart("X axis") { $0.xPropertyID = id.isEmpty ? nil : id } })) {
            Text("None (single bucket)").tag("")
            ForEach(categorical) { Text($0.name).tag($0.id) }
        }
        if let x = chart.xPropertyID, let p = ctx.db.property(x), [.date, .createdTime, .lastEditedTime].contains(p.type) {
            Picker("Group dates by", selection: Binding(get: { chart.dateBucket }, set: { b in updateChart("Date bucket") { $0.dateBucket = b } })) {
                ForEach(ChartConfig.DateBucket.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
        }
        Picker(chart.kind == .pie || chart.kind == .donut ? "Slice size" : "Y axis", selection: Binding(get: { chart.yPropertyID ?? "" }, set: { id in updateChart("Y axis") { $0.yPropertyID = id.isEmpty ? nil : id; if id.isEmpty { $0.aggregate = .count } else if $0.aggregate == .count { $0.aggregate = .sum } } })) {
            Text("Count of rows").tag("")
            ForEach(numeric) { Text($0.name).tag($0.id) }
        }
        if chart.yPropertyID != nil {
            Picker("Aggregate", selection: Binding(get: { chart.aggregate }, set: { a in updateChart("Aggregate") { $0.aggregate = a } })) {
                ForEach(ChartConfig.Aggregate.allCases.filter { $0 != .count }, id: \.self) { Text($0.displayName).tag($0) }
            }
        }
        Toggle("Show values", isOn: Binding(get: { chart.showValues }, set: { on in updateChart("Show values") { $0.showValues = on } }))
        Toggle("Show legend", isOn: Binding(get: { chart.showLegend }, set: { on in updateChart("Show legend") { $0.showLegend = on } }))
        Toggle("Sort by value", isOn: Binding(get: { chart.sortByValue }, set: { on in updateChart("Sort by value") { $0.sortByValue = on } }))
        Picker("Max categories", selection: Binding(get: { chart.limit ?? 0 }, set: { n in updateChart("Limit") { $0.limit = n == 0 ? nil : n } })) {
            Text("All").tag(0)
            ForEach([5, 8, 10, 15, 20], id: \.self) { Text("\($0) + Other").tag($0) }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(Theme.secondary)
            c()
        }
    }

    private var propertiesList: some View {
        let visible = v.visiblePropertyIDs(in: ctx.db)
        let ordered = visible.compactMap { ctx.db.property($0) } + ctx.db.properties.filter { !visible.contains($0.id) }
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(ordered.enumerated()), id: \.element.id) { i, p in
                HStack {
                    Label(p.name, systemImage: p.type.symbol)
                    Spacer()
                    if visible.contains(p.id), i > 0 {
                        Button { store.movePropertyInView(v.id, p.id, to: i - 1) } label: { Image(systemName: "arrow.up") }.buttonStyle(.plain)
                    }
                    if p.type != .title {
                        Button { store.setPropertyVisible(v.id, p.id, !visible.contains(p.id)) } label: {
                            Image(systemName: visible.contains(p.id) ? "eye" : "eye.slash")
                        }
                        .buttonStyle(.plain)
                    }
                }
                .foregroundStyle(visible.contains(p.id) ? Theme.primary : Theme.secondary)
            }
            HStack {
                Button("Show all") { for p in ctx.db.properties { store.setPropertyVisible(v.id, p.id, true) } }
                Button("Hide all") { for p in ctx.db.properties where p.type != .title { store.setPropertyVisible(v.id, p.id, false) } }
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
        }
    }

    @ViewBuilder
    private var grouping: some View {
        let groupable = ctx.db.properties.filter { [.select, .multiSelect, .status, .person, .checkbox, .text, .date, .createdTime, .lastEditedTime, .createdBy, .lastEditedBy, .url, .number, .formula, .relation].contains($0.type) }
        Picker("Group by", selection: Binding(get: { v.groupBy?.propertyID ?? "" }, set: { id in
            update("Group") { $0.groupBy = id.isEmpty ? nil : GroupRule(propertyID: id) }
        })) {
            Text("None").tag("")
            ForEach(groupable) { Text($0.name).tag($0.id) }
        }
        if let g = v.groupBy {
            Toggle("Hide empty groups", isOn: Binding(get: { g.hideEmptyGroups == true }, set: { on in update("Hide empty groups") { $0.groupBy?.hideEmptyGroups = on } }))
            if let p = ctx.db.property(g.propertyID), [.date, .createdTime, .lastEditedTime].contains(p.type) {
                Picker("Date by", selection: Binding(get: { g.dateGrouping ?? .relative }, set: { d in update("Date grouping") { $0.groupBy?.dateGrouping = d } })) {
                    ForEach(DateGrouping.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
            }
        }
    }

    private func coverKey(_ c: CardCover) -> String {
        switch c {
        case .none: return "none"
        case .pageCover: return "cover"
        case .pageContent: return "content"
        case .property(let p): return "p:" + p
        }
    }

    private func cover(fromKey k: String) -> CardCover {
        switch k {
        case "none": return CardCover.none
        case "cover": return .pageCover
        case "content": return .pageContent
        default: return .property(String(k.dropFirst(2)))
        }
    }
}

// MARK: - Properties

/// Menu shown when clicking a column header.
struct PropertyHeaderMenu: View {
    let ctx: DBContext
    let property: PropertySchema
    let done: () -> Void
    @State private var name = ""
    @State private var editingConfig = false

    private var store: WorkspaceStore { ctx.store }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("Property name", text: $name)
                .textFieldStyle(.roundedBorder)
                .disabled(ctx.locked)
                .onSubmit { rename() }
            if editingConfig {
                PropertyConfigEditor(db: ctx.db, propertyID: property.id)
            } else {
                if !ctx.locked {
                    if property.type != .title {
                        Menu {
                            ForEach(PropertyType.creatable, id: \.self) { t in
                                Button(t.displayName, systemImage: t.symbol) { store.changePropertyType(ctx.db.id, property.id, to: t) }
                            }
                        } label: { Label("Type: \(property.type.displayName)", systemImage: property.type.symbol) }
                        .menuStyle(.borderlessButton)
                    }
                    row("Edit property", "slider.horizontal.3") { editingConfig = true }
                }
                Divider()
                row("Sort ascending", "arrow.up") { sort(true) }
                row("Sort descending", "arrow.down") { sort(false) }
                row("Filter", "line.3.horizontal.decrease") { filter() }
                if property.type != .title {
                    row("Hide in view", "eye.slash") { store.setPropertyVisible(ctx.view.id, property.id, false); done() }
                }
                if !ctx.locked {
                    Divider()
                    row("Insert left", "arrow.left.to.line") { insert(left: true) }
                    row("Insert right", "arrow.right.to.line") { insert(left: false) }
                    if [.text, .select, .status, .multiSelect, .checkbox].contains(property.type) {
                        AutofillButton(databaseID: ctx.db.id, propertyID: property.id, rows: store.rows(of: ctx.db.id).map(\.id))
                            .buttonStyle(.plain).padding(.horizontal, 8).padding(.vertical, 4)
                    }
                    if property.type != .title {
                        row("Duplicate property", "plus.square.on.square") { _ = store.duplicateProperty(ctx.db.id, property.id); done() }
                        row("Delete property", "trash", destructive: true) { store.deleteProperty(ctx.db.id, property.id); done() }
                    }
                }
            }
        }
        .padding(10)
        .frame(width: 280)
        .onAppear { name = property.name }
        .onDisappear { rename() }
    }

    private func row(_ title: String, _ symbol: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(destructive ? Color.red : Theme.primary)
        }
        .buttonStyle(MenuRowStyle())
    }

    private func rename() {
        let n = name.trimmingCharacters(in: .whitespaces)
        if !n.isEmpty, n != property.name, !ctx.locked { store.renameProperty(ctx.db.id, property.id, to: n) }
    }

    private func sort(_ asc: Bool) {
        store.updateView(ctx.view.id, name: "Sort") { $0.sorts = [SortRule(propertyID: property.id, ascending: asc)] }
        done()
    }

    private func filter() {
        store.updateView(ctx.view.id, name: "Filter") { v in
            var g = v.filter ?? FilterGroup()
            g.items.append(.condition(FilterCondition(propertyID: property.id, op: FilterOp.ops(for: property.type).first ?? .contains)))
            v.filter = g
        }
        done()
    }

    private func insert(left: Bool) {
        let ids = ctx.db.properties.map(\.id)
        let after: String? = {
            guard let i = ids.firstIndex(of: property.id) else { return nil }
            return left ? (i > 0 ? ids[i - 1] : nil) : property.id
        }()
        _ = store.addProperty(to: ctx.db.id, name: "Property", type: .text, after: after, showIn: ctx.view.id)
        done()
    }
}

/// "+" in the table header: pick a type for a new property.
struct AddPropertyMenu: View {
    let ctx: DBContext
    let done: () -> Void
    @State private var created: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let id = created {
                PropertyConfigEditor(db: ctx.db, propertyID: id)
            } else {
                Text("Type").font(.caption).foregroundStyle(Theme.secondary)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(PropertyType.creatable, id: \.self) { t in
                            Button {
                                created = ctx.store.addProperty(to: ctx.db.id, name: t.displayName, type: t, showIn: ctx.view.id)
                                if created == nil { done() }
                            } label: {
                                Label(t.displayName, systemImage: t.symbol).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(MenuRowStyle())
                        }
                    }
                }
                .frame(maxHeight: 360)
            }
        }
        .padding(10)
        .frame(width: 280)
    }
}

/// Type-specific property settings (options, number format, formula, relation, rollup…).
struct PropertyConfigEditor: View {
    let db: Database
    let propertyID: String
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var formula = ""
    @State private var newOption = ""
    @State private var prefix = ""

    private var store: WorkspaceStore { model.store }

    var body: some View {
        let _ = model.registry.database(db.id).revision
        if let p = store.databases[db.id]?.property(propertyID) {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { if !name.isEmpty { store.renameProperty(db.id, p.id, to: name) } }
                if p.type != .title {
                    Menu {
                        ForEach(PropertyType.creatable, id: \.self) { t in
                            Button(t.displayName, systemImage: t.symbol) { store.changePropertyType(db.id, p.id, to: t) }
                        }
                    } label: { Label(p.type.displayName, systemImage: p.type.symbol) }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }
                config(p)
                TextField("Description", text: Binding(get: { p.description ?? "" }, set: { d in
                    store.updateProperty(db.id, p.id, name: "Description") { $0.description = d.isEmpty ? nil : d }
                }))
                .textFieldStyle(.roundedBorder)
            }
            .font(.system(size: 13))
            .onAppear { name = p.name; formula = p.formula ?? ""; prefix = p.idPrefix ?? "" }
        }
    }

    @ViewBuilder
    private func config(_ p: PropertySchema) -> some View {
        switch p.type {
        case .number:
            Picker("Number format", selection: Binding(get: { p.numberFormat ?? .number }, set: { f in
                store.updateProperty(db.id, p.id, name: "Number format") { $0.numberFormat = f }
            })) {
                ForEach(NumberFormat.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
        case .select, .multiSelect, .status:
            optionsEditor(p)
        case .formula:
            formulaEditor(p)
        case .relation:
            relationEditor(p)
        case .rollup:
            rollupEditor(p)
        case .uniqueID:
            TextField("Prefix", text: $prefix)
                .textFieldStyle(.roundedBorder)
                .onSubmit { store.updateProperty(db.id, p.id, name: "ID prefix") { $0.idPrefix = prefix.isEmpty ? nil : prefix } }
        case .date, .createdTime, .lastEditedTime:
            Picker("Date format", selection: Binding(get: { p.dateFormat ?? "" }, set: { f in
                store.updateProperty(db.id, p.id, name: "Date format") { $0.dateFormat = f.isEmpty ? nil : f }
            })) {
                Text("Full date").tag("")
                Text("Month/Day/Year").tag("MM/DD/YYYY")
                Text("Day/Month/Year").tag("DD/MM/YYYY")
                Text("Year/Month/Day").tag("YYYY/MM/DD")
                Text("Short").tag("MMM D, YYYY")
            }
        default:
            EmptyView()
        }
    }

    private func optionsEditor(_ p: PropertySchema) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Options").font(.caption).foregroundStyle(Theme.secondary)
            ForEach(p.options ?? []) { o in
                HStack {
                    Menu {
                        ForEach(TColor.textColors, id: \.self) { c in
                            Button(c.displayName) { store.updateOption(db.id, p.id, o.id) { $0.color = c } }
                        }
                    } label: { Circle().fill(Theme.optionBackground(o.color)).frame(width: 12, height: 12) }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    OptionNameField(option: o) { n in store.updateOption(db.id, p.id, o.id) { $0.name = n } }
                    if p.type == .status, let groups = p.statusGroups {
                        Menu(groups.first { $0.optionIDs.contains(o.id) }?.name ?? "Group") {
                            ForEach(groups) { g in
                                Button(g.name) {
                                    store.updateProperty(db.id, p.id, name: "Status group") { s in
                                        guard var gs = s.statusGroups else { return }
                                        for i in gs.indices { gs[i].optionIDs.removeAll { $0 == o.id } }
                                        if let gi = gs.firstIndex(where: { $0.id == g.id }) { gs[gi].optionIDs.append(o.id) }
                                        s.statusGroups = gs
                                    }
                                }
                            }
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                    }
                    Button { store.deleteOption(db.id, p.id, o.id) } label: { Image(systemName: "trash") }.buttonStyle(.plain)
                }
            }
            TextField("Add an option…", text: $newOption)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    let n = newOption.trimmingCharacters(in: .whitespaces)
                    if !n.isEmpty { _ = store.addOption(db.id, p.id, name: n) }
                    newOption = ""
                }
        }
    }

    private func formulaEditor(_ p: PropertySchema) -> some View {
        let engine = QueryEngine(store: store)
        let sample = store.rows(of: db.id).first
        let error: String? = {
            guard !formula.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            do { _ = try Formula(formula) } catch let e as FormulaError { return e.message } catch { return "\(error)" }
            return nil
        }()
        let preview: String? = {
            guard error == nil, let row = sample, let liveDB = store.databases[db.id] else { return nil }
            guard let v = try? Formula.evaluate(formula, engine.environment(row, liveDB)) else { return nil }
            return CellFormatter.text(v, store: store)
        }()
        return VStack(alignment: .leading, spacing: 4) {
            Text("Formula").font(.caption).foregroundStyle(Theme.secondary)
            TextEditor(text: $formula)
                .font(.system(size: 13, design: .monospaced))
                .frame(minHeight: 70)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color(Theme.divider)))
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            else if let preview, let row = sample { Text("\(store.title(of: row.id)) → \(preview)").font(.caption).foregroundStyle(Theme.secondary) }
            HStack {
                Menu("Insert property") {
                    ForEach(store.databases[db.id]?.properties ?? []) { q in
                        Button(q.name) { formula += "prop(\"\(q.name)\")" }
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                Menu("Functions") {
                    ForEach(Formula.functionNames, id: \.self) { f in Button(f) { formula += f + "(" } }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                Spacer()
                Button("Done") { store.updateProperty(db.id, p.id, name: "Edit formula") { $0.formula = formula } }
                    .disabled(error != nil)
            }
        }
    }

    @ViewBuilder
    private func relationEditor(_ p: PropertySchema) -> some View {
        let dbs = store.databases.values.filter { !store.isTrashed($0.blockID) }.sorted { store.title(of: $0.blockID) < store.title(of: $1.blockID) }
        Picker("Related to", selection: Binding(get: { p.relation?.databaseID ?? "" }, set: { id in
            store.updateProperty(db.id, p.id, name: "Relation") { $0.relation = id.isEmpty ? nil : RelationConfig(databaseID: id) }
        })) {
            Text("Select a database").tag("")
            ForEach(dbs, id: \.id) { d in Text(store.title(of: d.blockID)).tag(d.id) }
        }
        if let rel = p.relation {
            Toggle("Limit to 1 page", isOn: Binding(get: { rel.limitOne == true }, set: { on in
                store.updateProperty(db.id, p.id, name: "Limit relation") { $0.relation?.limitOne = on ? true : nil }
            }))
            if rel.syncedPropertyID == nil {
                Button("Show on \(store.title(of: store.databases[rel.databaseID]?.blockID ?? ""))") { store.makeRelationTwoWay(db.id, p.id) }
            } else {
                Text("Two-way relation").font(.caption).foregroundStyle(Theme.secondary)
            }
        }
    }

    @ViewBuilder
    private func rollupEditor(_ p: PropertySchema) -> some View {
        let relations = (store.databases[db.id]?.properties ?? []).filter { $0.type == .relation }
        let rel = p.rollup.flatMap { r in relations.first { $0.id == r.relationPropertyID } }
        let targetProps = rel?.relation.flatMap { store.databases[$0.databaseID]?.properties } ?? []
        Picker("Relation", selection: Binding(get: { p.rollup?.relationPropertyID ?? "" }, set: { id in
            store.updateProperty(db.id, p.id, name: "Rollup") { s in
                s.rollup = id.isEmpty ? nil : RollupConfig(relationPropertyID: id, targetPropertyID: Database.titlePropertyID, function: s.rollup?.function ?? .showOriginal)
            }
        })) {
            Text("Select a relation").tag("")
            ForEach(relations) { Text($0.name).tag($0.id) }
        }
        if let r = p.rollup {
            Picker("Property", selection: Binding(get: { r.targetPropertyID }, set: { id in
                store.updateProperty(db.id, p.id, name: "Rollup") { $0.rollup?.targetPropertyID = id }
            })) {
                ForEach(targetProps) { Text($0.name).tag($0.id) }
            }
            Picker("Calculate", selection: Binding(get: { r.function }, set: { f in
                store.updateProperty(db.id, p.id, name: "Rollup") { $0.rollup?.function = f }
            })) {
                ForEach(CalculationType.allCases.filter { $0 != .none }, id: \.self) { Text($0.displayName).tag($0) }
            }
        }
    }
}

struct OptionNameField: View {
    let option: SelectOption
    let commit: (String) -> Void
    @State private var draft = ""
    var body: some View {
        TextField("Option", text: $draft)
            .textFieldStyle(.plain)
            .onSubmit { let n = draft.trimmingCharacters(in: .whitespaces); if !n.isEmpty, n != option.name { commit(n) } }
            .onAppear { draft = option.name }
    }
}