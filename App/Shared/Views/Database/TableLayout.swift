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
        Button("Copy link", systemImage: "link") { Clipboard.copyLinks([row.id], store: ctx.store) }
    }
}

/// Title cell (Notion): icon + title; clicking the title opens the page (⌘-click: new tab), the pencil renames
/// it in place, and "Open" appears right after the title on hover — visible even when the column is wider than the viewport.
struct RowTitleCell: View {
    let ctx: DBContext
    let row: Block
    @State private var draft = ""
    @State private var hover = false
    @State private var editing = false
    @FocusState private var focused: Bool

    /// Rename + Open pills shown while the row is hovered.
    private var rowActions: some View {
        HStack(spacing: 2) {
            if !ctx.locked {
                Button { draft = row.title; editing = true; focused = true } label: {
                    Image(systemName: "pencil").font(.system(size: 11))
                        .frame(width: 24, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverHighlight(cornerRadius: 5, opacity: 0.08)
                .help("Rename")
            }
            Button { ctx.open(row.id) } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 10))
                    Text("Open").font(.system(size: 12, weight: .medium)).fixedSize()
                }
                .padding(.horizontal, 6)
                .frame(height: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverHighlight(cornerRadius: 5, opacity: 0.08)
            .help("Open (⌘-click: new tab)")
            .accessibilityIdentifier("table.rowOpen")
        }
        .foregroundStyle(Theme.secondary)
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(Theme.pageBackgroundColor))
                .shadow(color: .black.opacity(0.18), radius: 1.5, y: 0.5)
        )
    }

    var body: some View {
        HStack(spacing: 6) {
            if ctx.view.showIcons != false {
                PageIconView(icon: row.props.icon, size: 18)
            }
            if !ctx.locked && (editing || row.title.isEmpty) {
                TextField("Untitled", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium))
                    .focused($focused)
                    .onSubmit { editing = false }
                    .onChange(of: draft) { _, v in if v != row.title { ctx.store.setText(row.id, RichText(v)) } }
                    .onChange(of: focused) { _, f in if !f { editing = false } }
                    .onAppear { if editing { focused = true } }
            } else {
                Text(row.title.isEmpty ? "Untitled" : row.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(row.title.isEmpty ? Theme.secondary : Theme.primary)
                    .lineLimit(ctx.view.wrapCells == true ? nil : 1)
                    .underline(hover, color: Theme.secondary.opacity(0.35))
                    .contentShape(Rectangle())
                    .onTapGesture { ctx.open(row.id) }
                    .accessibilityIdentifier("table.rowTitle")
            }
            // Actions sit right after the title (not on the cell's trailing edge), so they stay visible
            // when the column is wider than the table viewport and the table is scrolled sideways.
            if hover && !editing {
                rowActions
                    .layoutPriority(2)
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { h in withAnimation(.easeOut(duration: 0.1)) { hover = h } }
        .onAppear { draft = row.title }
        .onChange(of: row.title) { _, v in if v != draft { draft = v } }
        #if os(iOS)
        .onLongPressGesture { ctx.open(row.id) }
        #endif
    }
}

/// Live column widths while a header edge is dragged, so the whole column follows the pointer (not just the header).
@Observable
final class TableColumnWidths {
    var live: [String: CGFloat] = [:]

    @MainActor
    func width(_ ctx: DBContext, _ p: PropertySchema) -> CGFloat {
        live[p.id] ?? TableHeader.width(ctx, p)
    }
}

struct TableLayout: View {
    let ctx: DBContext
    @State private var limitBoost = 0
    @State private var collapsed: Set<String> = []
    /// Multi-selected rows (hover checkbox, ⇧-click for a range) for bulk actions.
    @State private var selection: Set<RecordID> = []
    @State private var anchor: RecordID?
    @State private var columns = TableColumnWidths()
    /// Row frames for drag-selecting (a reference box, so frame updates don't re-render the table).
    @State private var rowFrames = RowFrameBox()
    @State private var dragBase: Set<RecordID>?

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
                        TableHeader(ctx: ctx, properties: props, columns: columns)
                    }
                    if let groups = ctx.visibleGroups {
                        ForEach(groups) { g in
                            GroupHeader(ctx: ctx, group: g, collapsed: collapsed.contains(g.id)) {
                                if collapsed.contains(g.id) { collapsed.remove(g.id) } else { collapsed.insert(g.id) }
                            }
                            if !collapsed.contains(g.id) {
                                rows(g.rows, props: props, ordered: ordered)
                                newRow(values: ctx.groupValues(g.id))
                                CalculationRow(ctx: ctx, properties: props, rows: g.rows, columns: columns).padding(.leading, Self.gutter)
                            }
                        }
                        HiddenGroupsFooter(ctx: ctx)
                    } else {
                        let limit = (ctx.view.loadLimit ?? 25) + limitBoost
                        rows(Array(ctx.result.rows.prefix(limit)), props: props, ordered: ordered)
                        if ctx.result.rows.count > limit {
                            HStack(spacing: 12) {
                                Button("Load \(min(50, ctx.result.rows.count - limit)) more") { limitBoost += 50 }
                                Button("Load all (\(ctx.result.rows.count))") { limitBoost = ctx.result.rows.count }
                                Text("\(limit) of \(ctx.result.rows.count)").foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.hoverFill).foregroundStyle(Theme.secondary).font(.callout).padding(6)
                            .padding(.leading, Self.gutter)
                            .accessibilityIdentifier("table.loadMore")
                        }
                        newRow(values: [:])
                        CalculationRow(ctx: ctx, properties: props, rows: ctx.result.rows, columns: columns).padding(.leading, Self.gutter)
                    }
                }
                .padding(.bottom, 4)
                .coordinateSpace(.named(rowSpace))
                // Notion: press in the checkbox column and drag over rows to select several at once.
                .simultaneousGesture(
                    DragGesture(minimumDistance: 3, coordinateSpace: .named(rowSpace))
                        .onChanged { g in
                            guard g.startLocation.x <= Self.gutter + 6 else { return }
                            if dragBase == nil {
                                dragBase = NSEvent.modifierFlags.contains(.shift) || NSEvent.modifierFlags.contains(.command) ? selection : []
                            }
                            let lo = min(g.startLocation.y, g.location.y), hi = max(g.startLocation.y, g.location.y)
                            let hit = ordered.filter { id in rowFrames.frames[id].map { $0.maxY > lo && $0.minY < hi } ?? false }
                            selection = (dragBase ?? []).union(hit)
                            anchor = hit.last ?? anchor
                        }
                        .onEnded { _ in dragBase = nil }
                )
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

    private var rowSpace: String { "dbRows-" + ctx.block.id }

    /// Rows in display order (groups flattened, collapsed groups skipped) — used for ⇧-click ranges.
    private var displayedRows: [RecordID] {
        if let groups = ctx.visibleGroups {
            return groups.filter { !collapsed.contains($0.id) }.flatMap(\.rows).map(\.id)
        }
        return ctx.result.rows.prefix((ctx.view.loadLimit ?? 25) + limitBoost).map(\.id)
    }

    private func rows(_ rows: [Block], props: [PropertySchema], ordered: [RecordID]) -> some View {
        ForEach(rows, id: \.id) { row in
            TableRowView(ctx: ctx, row: row, props: props, columns: columns, selected: selection.contains(row.id),
                         selectionActive: !selection.isEmpty) { shift in
                toggle(row.id, shift: shift, ordered: ordered)
            }
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(rowSpace)) }) { [box = rowFrames, id = row.id] f in box.frames[id] = f }
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
        SelectAllBox(all: !ordered.isEmpty && selection.count == ordered.count, any: !selection.isEmpty) {
            let all = !ordered.isEmpty && selection.count == ordered.count
            selection = all ? [] : Set(ordered)
        }
    }

    private func bulkBar(_ ordered: [RecordID]) -> some View {
        HStack(spacing: 12) {
            Text("\(selection.count) selected").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.accentBlue)
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
        .buttonStyle(.quiet)
        .font(.system(size: 13))
        .foregroundStyle(Theme.secondary)
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.accentBlue.opacity(0.08)))
        .padding(.bottom, 4)
        .accessibilityIdentifier("table.bulkBar")
    }

    @ViewBuilder
    private func bulkMenu(_ ordered: [RecordID]) -> some View {
        let ids = ordered.filter { selection.contains($0) }
        Button("Open \(ids.count) in new tabs", systemImage: "plus.square.on.square") {
            for id in ids { ctx.model.openInNewTab(id, activate: false) }
        }
        Button("Copy links", systemImage: "link") { Clipboard.copyLinks(ids, store: ctx.store) }
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
                HStack(spacing: 6) {
                    Image(systemName: "plus").font(.system(size: 12))
                    Text("New page").font(.system(size: 14))
                }
                .foregroundStyle(Theme.secondary)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverHighlight(cornerRadius: 0, opacity: 0.035)
            .padding(.leading, Self.gutter)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.gridLine).frame(height: 1).padding(.leading, Self.gutter) }
            .accessibilityIdentifier("table.newRow")
        }
    }
}

/// Header checkbox: invisible until the header is hovered or rows are selected.
private struct SelectAllBox: View {
    let all: Bool
    let any: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: all ? "checkmark.square.fill" : (any ? "minus.square.fill" : "square"))
                .font(.system(size: 13, weight: .light))
                .foregroundStyle(any ? Theme.accentBlue : Theme.secondary)
                .frame(width: TableLayout.gutter, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(hover || any ? 1 : 0)
        .onHover { hover = $0 }
        .help(all ? "Deselect all" : "Select all rows")
        .accessibilityIdentifier("table.selectAll")
    }
}

/// One table row: checkbox gutter (on hover / while selecting) + cells, soft highlight under the pointer.
struct TableRowView: View {
    let ctx: DBContext
    let row: Block
    let props: [PropertySchema]
    let columns: TableColumnWidths
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
                TodoCheckbox(checked: selected)
                    .scaleEffect(0.85)
                    .frame(width: TableLayout.gutter, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(hover || selectionActive ? 1 : 0)
            .help("Select row (⇧-click for a range)")
            .accessibilityIdentifier("table.rowSelect")
            HStack(spacing: 0) {
                ForEach(Array(props.enumerated()), id: \.element.id) { i, p in
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
                    .frame(width: columns.width(ctx, p), height: wrap ? nil : TableLayout.rowHeight, alignment: .leading)
                    .clipped()
                    .overlay(alignment: .trailing) {
                        if i < props.count - 1 { Rectangle().fill(Theme.gridLine).frame(width: 1) }
                    }
                }
            }
            .background(selected ? Theme.accentBlue.opacity(0.12) : (hover ? Theme.primary.opacity(0.03) : Color.clear))
        }
        .frame(minHeight: TableLayout.rowHeight)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.gridLine).frame(height: 1).padding(.leading, TableLayout.gutter) }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

struct TableHeader: View {
    let ctx: DBContext
    let properties: [PropertySchema]
    let columns: TableColumnWidths
    @State private var adding = false

    static func width(_ ctx: DBContext, _ p: PropertySchema) -> CGFloat {
        if let w = ctx.view.properties?.first(where: { $0.id == p.id })?.width { return CGFloat(w) }
        return p.type == .title ? 280 : 180
    }

    var body: some View {
        HStack(spacing: 0) {
            // Earlier cells sit above later ones, so each resize edge (which overhangs the border by half its
            // width) is never covered by the next header.
            ForEach(Array(properties.enumerated()), id: \.element.id) { i, p in
                HeaderCell(ctx: ctx, property: p, columns: columns, last: i == properties.count - 1)
                    .zIndex(Double(properties.count - i))
            }
            .accessibilityIdentifier("table.header")
            if !ctx.locked {
                Button { adding = true } label: { ToolbarIcon("plus", size: 12) }
                    .buttonStyle(.quiet(padding: 4, minSize: 28))
                    .padding(.leading, 2)
                    .help("Add a property")
                    .popover(isPresented: $adding) { AddPropertyMenu(ctx: ctx) { adding = false } }
            }
        }
        .font(.system(size: 14))
        .foregroundStyle(Theme.secondary)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.gridLine).frame(height: 1) }
    }
}

/// Column header (Notion): gray type icon + name, hover fill; click for the property menu. The right edge is a
/// 12 pt resize handle with the resize cursor and a blue line, and the whole column follows the drag live.
struct HeaderCell: View {
    let ctx: DBContext
    let property: PropertySchema
    let columns: TableColumnWidths
    var last = false
    @State private var editing = false
    @State private var hover = false
    @State private var start: CGFloat?

    var body: some View {
        let w = columns.width(ctx, property)
        Button { editing = true } label: {
            HStack(spacing: 6) {
                Image(systemName: property.type.symbol)
                    .font(.system(size: 12, weight: .regular))
                    .frame(width: 16)
                Text(property.name).lineLimit(1)
            }
            .padding(.horizontal, 8)
            .frame(width: w, height: 33, alignment: .leading)
            .background(Theme.primary.opacity(hover || editing ? 0.045 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.1)) { hover = h } }
        .overlay(alignment: .trailing) {
            ZStack {
                if !last { Rectangle().fill(Theme.gridLine).frame(width: 1) }
                if !ctx.locked {
                    ResizeHandle(onBegan: { start = TableHeader.width(ctx, property) },
                                 onChanged: { dx in columns.live[property.id] = max(80, (start ?? w) + dx) },
                                 onEnded: {
                                     if let lw = columns.live[property.id] { ctx.store.setColumnWidth(ctx.view.id, property.id, Double(lw)) }
                                     columns.live[property.id] = nil
                                     start = nil
                                 })
                }
            }
            .frame(width: 12)
            .offset(x: 6)
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
            .buttonStyle(.hoverFill)
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
    let columns: TableColumnWidths
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
                        }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: columns.width(ctx, p))
                // Menu labels ignore opacity inside them on macOS, so the whole empty menu fades instead.
                .opacity(fn != .none || hovering ? 1 : 0)
            }
        }
        .contentShape(Rectangle())
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hovering = h } }
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
                Button { ctx.open(ctx.addRow()) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus").font(.system(size: 12)).frame(width: 18)
                        Text("New page").font(.system(size: 14))
                    }
                    .foregroundStyle(Theme.secondary)
                    .padding(.horizontal, 6)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverHighlight()
            }
        }
    }
}

struct ListRow: View {
    let ctx: DBContext
    let row: Block

    var body: some View {
        HStack(spacing: 8) {
            PageIconView(icon: row.props.icon, size: 18)
            Text(row.title.isEmpty ? "Untitled" : row.title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(row.title.isEmpty ? Theme.secondary : Theme.primary)
                .lineLimit(1)
            Spacer(minLength: 12)
            ForEach(ctx.cardProperties) { p in
                let v = ctx.value(row, p)
                if !v.isEmpty || p.type == .checkbox {
                    PropertyValueView(property: p, value: v, row: row).font(.system(size: 13)).foregroundStyle(Theme.secondary)
                }
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 6)
        .frame(minHeight: 32)
        .contentShape(Rectangle())
        .hoverHighlight()
        .onTapGesture { ctx.open(row.id) }
        .contextMenu { RowMenuItems(ctx: ctx, row: row) }
        .accessibilityIdentifier("list.row")
    }
}


/// Row frames of one table view, kept outside SwiftUI state.
final class RowFrameBox { var frames: [RecordID: CGRect] = [:] }
