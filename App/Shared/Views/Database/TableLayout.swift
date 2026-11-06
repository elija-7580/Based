import SwiftUI
import BasedCore

extension CalculationType {
    static func options(for type: PropertyType) -> [CalculationType] {
        let counts: [CalculationType] = [.none, .countAll, .countValues, .countUnique, .countEmpty, .countNotEmpty, .percentEmpty, .percentNotEmpty]
        switch type {
        case .number, .formula, .rollup: return counts + [.sum, .average, .median, .min, .max, .range]
        case .date, .createdTime, .lastEditedTime: return counts + [.earliest, .latest, .dateRange]
        case .checkbox: return [.none, .countAll, .checked, .unchecked, .percentChecked, .percentUnchecked]
        default: return counts
        }
    }
}

/// Row actions shared by every layout.
struct RowMenuItems: View {
    let ctx: DBContext
    let row: Block

    var body: some View {
        Button("Open", systemImage: "arrow.up.right.square") { ctx.open(row.id) }
        Menu("Open in") {
            ForEach(OpenMode.allCases, id: \.self) { m in Button(m.displayName) { ctx.model.open(row.id, mode: m) } }
        }
        if !ctx.locked {
            Divider()
            Button("Duplicate", systemImage: "plus.square.on.square") { _ = ctx.store.duplicateBlocks([row.id]) }
            Button("Delete", systemImage: "trash", role: .destructive) { ctx.model.trash(row.id) }
        }
        Divider()
        Button("Copy link", systemImage: "link") { Clipboard.copy("based://page/" + row.id) }
    }
}

/// Title cell: inline editable title + "Open" on hover.
struct RowTitleCell: View {
    let ctx: DBContext
    let row: Block
    @State private var draft = ""
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            if let icon = row.props.icon, ctx.view.showIcons != false { icon.view(size: 16, assets: ctx.model.assets).frame(width: 18, height: 18) }
            else if ctx.view.showIcons != false { Image(systemName: "doc").font(.system(size: 12)).foregroundStyle(Theme.secondary) }
            if ctx.locked {
                Text(row.title.isEmpty ? "Untitled" : row.title).fontWeight(.medium).lineLimit(ctx.view.wrapCells == true ? nil : 1)
            } else {
                TextField("Untitled", text: $draft)
                    .textFieldStyle(.plain)
                    .fontWeight(.medium)
                    .onChange(of: draft) { _, v in if v != row.title { ctx.store.setText(row.id, RichText(v)) } }
            }
            Spacer(minLength: 0)
            if hover {
                Button { ctx.open(row.id) } label: {
                    Label("Open", systemImage: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 11))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(.background).shadow(radius: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .onHover { hover = $0 }
        .onAppear { draft = row.title }
        .onChange(of: row.title) { _, v in if v != draft { draft = v } }
        #if os(iOS)
        .onLongPressGesture { ctx.open(row.id) }
        #endif
    }
}

struct TableLayout: View {
    let ctx: DBContext
    @State private var limitBoost = 0
    @State private var collapsed: Set<String> = []

    var body: some View {
        let props = ctx.visibleProperties
        ScrollView(.horizontal, showsIndicators: true) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
                TableHeader(ctx: ctx, properties: props)
                if let groups = ctx.visibleGroups {
                    ForEach(groups) { g in
                        GroupHeader(ctx: ctx, group: g, collapsed: collapsed.contains(g.id)) {
                            if collapsed.contains(g.id) { collapsed.remove(g.id) } else { collapsed.insert(g.id) }
                        }
                        if !collapsed.contains(g.id) {
                            rows(g.rows, props: props)
                            newRow(values: ctx.groupValues(g.id))
                            CalculationRow(ctx: ctx, properties: props, rows: g.rows)
                        }
                    }
                    HiddenGroupsFooter(ctx: ctx)
                } else {
                    let limit = (ctx.view.loadLimit ?? 50) + limitBoost
                    rows(Array(ctx.result.rows.prefix(limit)), props: props)
                    if ctx.result.rows.count > limit {
                        HStack(spacing: 12) {
                            Button("Load \(min(50, ctx.result.rows.count - limit)) more") { limitBoost += 50 }
                            Button("Load all (\(ctx.result.rows.count))") { limitBoost = ctx.result.rows.count }
                            Text("\(limit) of \(ctx.result.rows.count)").foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.plain).foregroundStyle(Theme.secondary).font(.callout).padding(6)
                        .accessibilityIdentifier("table.loadMore")
                    }
                    newRow(values: [:])
                    CalculationRow(ctx: ctx, properties: props, rows: ctx.result.rows)
                }
            }
            .padding(.bottom, 4)
        }
    }

    private func rows(_ rows: [Block], props: [PropertySchema]) -> some View {
        ForEach(rows, id: \.id) { row in
            HStack(spacing: 0) {
                ForEach(props) { p in
                    Group {
                        if p.type == .title {
                            RowTitleCell(ctx: ctx, row: row)
                        } else {
                            PropertyCell(db: ctx.db, row: row, property: p, value: ctx.value(row, p),
                                         locked: ctx.locked, wrap: ctx.view.wrapCells == true)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .frame(width: TableHeader.width(ctx, p), alignment: .leading)
                    .overlay(alignment: .trailing) { Rectangle().fill(Color(Theme.divider)).frame(width: 1) }
                }
            }
            .overlay(alignment: .bottom) { Rectangle().fill(Color(Theme.divider)).frame(height: 1) }
            .contextMenu { RowMenuItems(ctx: ctx, row: row) }
        }
    }

    @ViewBuilder
    private func newRow(values: [String: PropertyValue]) -> some View {
        if !ctx.locked {
            Button { ctx.addRow(values: values) } label: {
                Label("New page", systemImage: "plus").foregroundStyle(Theme.secondary).padding(.vertical, 6).padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(Theme.divider)).frame(height: 1) }
        }
    }
}

struct TableHeader: View {
    let ctx: DBContext
    let properties: [PropertySchema]
    @State private var adding = false

    static func width(_ ctx: DBContext, _ p: PropertySchema) -> CGFloat {
        if let w = ctx.view.properties?.first(where: { $0.id == p.id })?.width { return CGFloat(w) }
        return p.type == .title ? 280 : 180
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(properties) { p in HeaderCell(ctx: ctx, property: p) }
                .accessibilityIdentifier("table.header")
            if !ctx.locked {
                Button { adding = true } label: { Image(systemName: "plus").padding(8) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.secondary)
                    .popover(isPresented: $adding) { AddPropertyMenu(ctx: ctx) { adding = false } }
            }
        }
        .font(.system(size: 13))
        .foregroundStyle(Theme.secondary)
        .overlay(alignment: .bottom) { Rectangle().fill(Color(Theme.divider)).frame(height: 1) }
    }
}

/// Column header: click for the property menu, drag the right edge to resize.
struct HeaderCell: View {
    let ctx: DBContext
    let property: PropertySchema
    @State private var editing = false
    @State private var liveWidth: CGFloat?

    var body: some View {
        let w = liveWidth ?? TableHeader.width(ctx, property)
        Button { editing = true } label: {
            Label(property.name, systemImage: property.type.symbol)
                .lineLimit(1)
                .padding(.horizontal, 8).padding(.vertical, 7)
                .frame(width: w, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            Rectangle().fill(Color(Theme.divider)).frame(width: 1)
                .overlay(Color.clear.frame(width: 8).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 1)
                        .onChanged { g in liveWidth = max(80, TableHeader.width(ctx, property) + g.translation.width) }
                        .onEnded { _ in
                            if let lw = liveWidth { ctx.store.setColumnWidth(ctx.view.id, property.id, Double(lw)) }
                            liveWidth = nil
                        }))
        }
        .popover(isPresented: $editing) {
            PropertyHeaderMenu(ctx: ctx, property: property) { editing = false }
        }
    }
}

struct GroupHeader: View {
    let ctx: DBContext
    let group: RowGroup
    var collapsed = false
    let toggle: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button(action: toggle) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down").font(.system(size: 11))
            }
            .buttonStyle(.plain)
            GroupTitle(group: group, property: ctx.groupProperty)
            Text("\(group.rows.count)").foregroundStyle(Theme.secondary)
            Spacer()
            Menu {
                Button("Hide group") { ctx.setGroupHidden(group.id, true) }
            } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .font(.system(size: 14, weight: .medium))
        .padding(.vertical, 8)
        .padding(.top, 8)
    }
}

struct GroupTitle: View {
    let group: RowGroup
    let property: PropertySchema?

    var body: some View {
        if group.isEmptyGroup {
            Text(property.map { "No \($0.name)" } ?? "No value").foregroundStyle(Theme.secondary)
        } else if property?.type == .status, let o = property?.option(group.id) {
            StatusPill(option: o, property: property!)
        } else if let c = group.color {
            OptionPill(name: group.title, color: c)
        } else {
            Text(group.title)
        }
    }
}

struct HiddenGroupsFooter: View {
    let ctx: DBContext
    var body: some View {
        let hidden = ctx.hiddenGroups
        if !hidden.isEmpty {
            Menu("\(hidden.count) hidden group\(hidden.count == 1 ? "" : "s")") {
                ForEach(hidden) { g in Button("Show \(g.isEmptyGroup ? "No value" : g.title)") { ctx.setGroupHidden(g.id, false) } }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .foregroundStyle(Theme.secondary)
            .padding(.vertical, 6)
        }
    }
}

/// Footer with per-column calculations.
struct CalculationRow: View {
    let ctx: DBContext
    let properties: [PropertySchema]
    let rows: [Block]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(properties) { p in
                let fn = ctx.view.calculations?[p.id] ?? .none
                Menu {
                    ForEach(CalculationType.options(for: p.type), id: \.self) { c in
                        Button(c.displayName) {
                            ctx.store.updateView(ctx.view.id, name: "Calculate") { v in
                                var calc = v.calculations ?? [:]
                                calc[p.id] = c == .none ? nil : c
                                v.calculations = calc.isEmpty ? nil : calc
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Spacer()
                        if fn != .none, let s = ctx.engine.calculation(fn, p, rows: rows, db: ctx.db) {
                            Text(fn.displayName.uppercased()).font(.system(size: 10)).foregroundStyle(Theme.secondary)
                            Text(s).font(.system(size: 13))
                        } else {
                            Text("Calculate").font(.system(size: 12)).foregroundStyle(Theme.secondary.opacity(0.6))
                        }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: TableHeader.width(ctx, p))
            }
        }
    }
}

// MARK: - List

struct ListLayout: View {
    let ctx: DBContext

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let groups = ctx.visibleGroups {
                ForEach(groups) { g in
                    GroupHeader(ctx: ctx, group: g) {}
                    ForEach(g.rows, id: \.id) { row in ListRow(ctx: ctx, row: row) }
                }
                HiddenGroupsFooter(ctx: ctx)
            } else {
                ForEach(ctx.result.rows.prefix(ctx.view.loadLimit ?? 100), id: \.id) { row in ListRow(ctx: ctx, row: row) }
            }
            if !ctx.locked {
                Button { ctx.open(ctx.addRow()) } label: { Label("New page", systemImage: "plus").foregroundStyle(Theme.secondary) }
                    .buttonStyle(.plain)
                    .padding(.vertical, 6)
            }
        }
    }
}

struct ListRow: View {
    let ctx: DBContext
    let row: Block

    var body: some View {
        HStack(spacing: 8) {
            PageIconView(icon: row.props.icon, size: 16)
            Text(row.title.isEmpty ? "Untitled" : row.title).fontWeight(.medium).lineLimit(1)
            Spacer(minLength: 12)
            ForEach(ctx.cardProperties) { p in
                let v = ctx.value(row, p)
                if !v.isEmpty || p.type == .checkbox {
                    PropertyValueView(property: p, value: v, row: row).font(.system(size: 13)).foregroundStyle(Theme.secondary)
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .onTapGesture { ctx.open(row.id) }
        .contextMenu { RowMenuItems(ctx: ctx, row: row) }
        .overlay(alignment: .bottom) { Rectangle().fill(Color(Theme.divider)).frame(height: 1) }
    }
}