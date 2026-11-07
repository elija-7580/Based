import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#endif

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
    /// Multi-selected rows (hover checkbox, ⇧-click for a range) for bulk actions.
    @State private var selection: Set<RecordID> = []
    @State private var anchor: RecordID?

    /// Width of the checkbox gutter left of each row.
    static let gutter: CGFloat = 28
    /// One-line row height (Notion: 33 pt + 1 pt border).
    static let rowHeight: CGFloat = 34

    var body: some View {
        let props = ctx.visibleProperties
        let ordered = displayedRows
        VStack(alignment: .leading, spacing: 0) {
            if !selection.isEmpty { bulkBar(ordered) }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
                    HStack(spacing: 0) {
                        selectAll(ordered)
                        TableHeader(ctx: ctx, properties: props)
                    }
                    if let groups = ctx.visibleGroups {
                        ForEach(groups) { g in
                            GroupHeader(ctx: ctx, group: g, collapsed: collapsed.contains(g.id)) {
                                if collapsed.contains(g.id) { collapsed.remove(g.id) } else { collapsed.insert(g.id) }
                            }
                            if !collapsed.contains(g.id) {
                                rows(g.rows, props: props, ordered: ordered)
                                newRow(values: ctx.groupValues(g.id))
                                CalculationRow(ctx: ctx, properties: props, rows: g.rows).padding(.leading, Self.gutter)
                            }
                        }
                        HiddenGroupsFooter(ctx: ctx)
                    } else {
                        let limit = (ctx.view.loadLimit ?? 50) + limitBoost
                        rows(Array(ctx.result.rows.prefix(limit)), props: props, ordered: ordered)
                        if ctx.result.rows.count > limit {
                            HStack(spacing: 12) {
                                Button("Load \(min(50, ctx.result.rows.count - limit)) more") { limitBoost += 50 }
                                Button("Load all (\(ctx.result.rows.count))") { limitBoost = ctx.result.rows.count }
                                Text("\(limit) of \(ctx.result.rows.count)").foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.plain).foregroundStyle(Theme.secondary).font(.callout).padding(6)
                            .padding(.leading, Self.gutter)
                            .accessibilityIdentifier("table.loadMore")
                        }
                        newRow(values: [:])
                        CalculationRow(ctx: ctx, properties: props, rows: ctx.result.rows).padding(.leading, Self.gutter)
                    }
                }
                .padding(.bottom, 4)
            }
        }
        .onKeyPress(.escape) {
            guard !selection.isEmpty else { return .ignored }
            selection = []
            return .handled
        }
        .onChange(of: ctx.result.rows.map(\.id)) { _, ids in
            // Drop rows that were deleted / filtered away.
            let alive = Set(ids)
            if !selection.isSubset(of: alive) { selection.formIntersection(alive) }
        }
    }

    /// Rows in display order (groups flattened, collapsed groups skipped) — used for ⇧-click ranges.
    private var displayedRows: [RecordID] {
        if let groups = ctx.visibleGroups {
            return groups.filter { !collapsed.contains($0.id) }.flatMap(\.rows).map(\.id)
        }
        return ctx.result.rows.prefix((ctx.view.loadLimit ?? 50) + limitBoost).map(\.id)
    }

    private func rows(_ rows: [Block], props: [PropertySchema], ordered: [RecordID]) -> some View {
        ForEach(rows, id: \.id) { row in
            TableRowView(ctx: ctx, row: row, props: props, selected: selection.contains(row.id),
                         selectionActive: !selection.isEmpty) { shift in
                toggle(row.id, shift: shift, ordered: ordered)
            }
            .contextMenu {
                if selection.count > 1, selection.contains(row.id) {
                    bulkMenu(ordered)
                } else {
                    RowMenuItems(ctx: ctx, row: row)
                }
            }
        }
    }

    private func toggle(_ id: RecordID, shift: Bool, ordered: [RecordID]) {
        if shift, let a = anchor, let i = ordered.firstIndex(of: a), let j = ordered.firstIndex(of: id) {
            selection.formUnion(ordered[min(i, j)...max(i, j)])
        } else if selection.contains(id) {
            selection.remove(id)
        } else {
            selection.insert(id)
        }
        anchor = id
    }

    private func selectAll(_ ordered: [RecordID]) -> some View {
        let all = !ordered.isEmpty && selection.count == ordered.count
        return Button {
            selection = all ? [] : Set(ordered)
        } label: {
            Image(systemName: all ? "checkmark.square.fill" : (selection.isEmpty ? "square" : "minus.square.fill"))
                .foregroundStyle(selection.isEmpty ? Theme.secondary.opacity(0.5) : Color.accentColor)
                .frame(width: Self.gutter, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(all ? "Deselect all" : "Select all rows")
        .accessibilityIdentifier("table.selectAll")
    }

    private func bulkBar(_ ordered: [RecordID]) -> some View {
        HStack(spacing: 12) {
            Text("\(selection.count) selected").font(.system(size: 13, weight: .medium)).foregroundStyle(Color.accentColor)
            Divider().frame(height: 14)
            Menu { bulkMenu(ordered) } label: { Label("Actions", systemImage: "ellipsis.circle") }
                .menuStyle(.borderlessButton).fixedSize()
            if !ctx.locked {
                Button { bulkDuplicate(ordered) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                Button(role: .destructive) { bulkDelete() } label: { Label("Delete", systemImage: "trash") }
                    .accessibilityIdentifier("table.bulkDelete")
            }
            Spacer()
            Button { selection = [] } label: { Image(systemName: "xmark") }.help("Clear selection (Esc)")
        }
        .buttonStyle(.plain)
        .font(.system(size: 13))
        .foregroundStyle(Theme.secondary)
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.08)))
        .padding(.bottom, 4)
        .accessibilityIdentifier("table.bulkBar")
    }

    @ViewBuilder
    private func bulkMenu(_ ordered: [RecordID]) -> some View {
        let ids = ordered.filter { selection.contains($0) }
        Button("Open \(ids.count) in new tabs", systemImage: "plus.square.on.square") {
            for id in ids { ctx.model.openInNewTab(id, activate: false) }
        }
        Button("Copy links", systemImage: "link") { Clipboard.copy(ids.map { "based://page/" + $0 }.joined(separator: "\n")) }
        if !ctx.locked {
            Divider()
            Button("Duplicate \(ids.count)", systemImage: "plus.square.on.square") { bulkDuplicate(ordered) }
            Button("Delete \(ids.count)", systemImage: "trash", role: .destructive) { bulkDelete() }
        }
    }

    private func bulkDuplicate(_ ordered: [RecordID]) {
        let ids = ordered.filter { selection.contains($0) }
        _ = ctx.store.duplicateBlocks(ids)
        selection = []
    }

    private func bulkDelete() {
        let ids = Array(selection)
        Log.info("table: delete \(ids.count) rows", category: "database")
        ctx.store.trash(ids)
        selection = []
    }

    @ViewBuilder
    private func newRow(values: [String: PropertyValue]) -> some View {
        if !ctx.locked {
            Button { ctx.addRow(values: values) } label: {
                Label("New page", systemImage: "plus").foregroundStyle(Theme.secondary).padding(.vertical, 6).padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.leading, Self.gutter)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(Theme.divider)).frame(height: 1).padding(.leading, Self.gutter) }
        }
    }
}

/// One table row: checkbox gutter (on hover / while selecting) + cells.
struct TableRowView: View {
    let ctx: DBContext
    let row: Block
    let props: [PropertySchema]
    let selected: Bool
    let selectionActive: Bool
    let toggle: (_ shift: Bool) -> Void
    @State private var hover = false
    private var wrap: Bool { ctx.view.wrapCells == true }

    var body: some View {
        HStack(spacing: 0) {
            Button {
                #if os(macOS)
                toggle(NSEvent.modifierFlags.contains(.shift))
                #else
                toggle(false)
                #endif
            } label: {
                Image(systemName: selected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(selected ? Color.accentColor : Theme.secondary)
                    .frame(width: TableLayout.gutter, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(hover || selectionActive ? 1 : 0)
            .help("Select row (⇧-click for a range)")
            .accessibilityIdentifier("table.rowSelect")
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
                .padding(.vertical, wrap ? 6 : 0)
                // Notion: without "Wrap cells" every row is one line high (33 pt) and cells clip.
                .frame(width: TableHeader.width(ctx, p), height: wrap ? nil : TableLayout.rowHeight, alignment: .leading)
                .clipped()
                .overlay(alignment: .trailing) { Rectangle().fill(Color(Theme.divider)).frame(width: 1) }
            }
        }
        .frame(minHeight: TableLayout.rowHeight)
        .background(selected ? Color.accentColor.opacity(0.1) : Color.clear)
        .overlay(alignment: .bottom) { Rectangle().fill(Color(Theme.divider)).frame(height: 1).padding(.leading, TableLayout.gutter) }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
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
    /// "Calculate ⌄" labels only show on hover (like Notion) so empty footers don't clutter the table.
    @State private var hovering = false

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
                                .opacity(hovering ? 1 : 0)
                        }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: TableHeader.width(ctx, p))
            }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
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