import SwiftUI
import BasedCore

/// Notion-style dashboard: rows of up to four widgets on a 12-column grid. Each widget is a view (chart, table,
/// board, …) of this or another database, rendered with the normal layouts. Widgets can be added, resized
/// (width presets), moved between rows, pointed at another database, and removed.
struct DashboardLayout: View {
    let ctx: DBContext
    @Environment(AppModel.self) private var model

    var body: some View {
        let config = ctx.view.dashboard ?? DashboardConfig()
        VStack(alignment: .leading, spacing: 12) {
            if config.rows.isEmpty {
                ContentUnavailableView("Empty dashboard", systemImage: "square.grid.2x2",
                                       description: Text("Add charts, tables, boards and other views as widgets."))
                    .frame(maxWidth: .infinity, minHeight: 200)
            }
            ForEach(Array(config.rows.enumerated()), id: \.element.id) { index, row in
                DashboardRowView(ctx: ctx, row: row, rowIndex: index, rowCount: config.rows.count)
            }
            if !ctx.locked {
                AddWidgetMenu(ctx: ctx, rowIndex: nil) {
                    Label("Add widget", systemImage: "plus")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .accessibilityIdentifier("dashboard.addWidget")
            }
        }
        .padding(.vertical, 8)
        .accessibilityIdentifier("dashboard")
    }
}

/// One dashboard row; widget widths are fractions of 12 columns.
struct DashboardRowView: View {
    let ctx: DBContext
    let row: DashboardConfig.Row
    let rowIndex: Int
    let rowCount: Int
    @State private var hover = false

    var body: some View {
        GeometryReader { geo in
            let spacing: CGFloat = 12
            let usable = max(0, geo.size.width - spacing * CGFloat(max(0, row.widgets.count - 1)))
            let total = max(1, row.widgets.reduce(0) { $0 + $1.width })
            HStack(alignment: .top, spacing: spacing) {
                ForEach(row.widgets) { w in
                    DashboardWidgetCard(ctx: ctx, widget: w, rowIndex: rowIndex, rowCount: rowCount,
                                        rowFull: row.widgets.count >= DashboardConfig.maxWidgetsPerRow)
                        .frame(width: usable * CGFloat(w.width) / CGFloat(total), height: rowHeight)
                }
            }
        }
        .frame(height: rowHeight)
        .overlay(alignment: .trailing) {
            if hover, !ctx.locked, row.widgets.count < DashboardConfig.maxWidgetsPerRow {
                AddWidgetMenu(ctx: ctx, rowIndex: rowIndex) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(.background).shadow(color: .black.opacity(0.15), radius: 2))
                }
                .help("Add widget to this row")
                .offset(x: 11)
            }
        }
        .onHover { hover = $0 }
    }

    /// Fixed height from Notion, otherwise the tallest widget's natural height.
    private var rowHeight: CGFloat {
        if let h = row.height, h > 80 { return h }
        let heights = row.widgets.map { w -> CGFloat in
            guard let v = ctx.store.views[w.viewID] else { return 160 }
            switch v.type {
            case .chart:
                return v.chart?.kind == .number ? 150 : CGFloat(v.chart?.heightPoints ?? 280) + 70
            case .calendar, .board, .timeline, .map: return 420
            default: return 340
            }
        }
        return heights.max() ?? 200
    }
}

/// A widget: title bar ("…" menu on hover) and the view's layout.
struct DashboardWidgetCard: View {
    let ctx: DBContext
    let widget: DashboardConfig.Widget
    let rowIndex: Int
    let rowCount: Int
    let rowFull: Bool
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var renaming = false
    @State private var name = ""

    var body: some View {
        let store = model.store
        let view = model.registry.view(widget.viewID).view
        VStack(alignment: .leading, spacing: 0) {
            if let view, let db = store.databases[view.databaseID] {
                header(view, db: db)
                Divider().opacity(0.6)
                let wctx = DBContext(block: ctx.block, db: db, view: view, engine: model.queryCache.queryEngine,
                                     result: model.queryCache.run(view), model: model, locked: ctx.locked || db.locked == true)
                ScrollView([.vertical]) {
                    widgetBody(wctx)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 8)
                }
                .scrollIndicators(.automatic)
            } else {
                HStack {
                    Text("This widget's database was deleted.").font(.callout).foregroundStyle(Theme.secondary)
                    Spacer()
                    if !ctx.locked { Button("Remove") { store.removeDashboardWidget(ctx.view.id, widget: widget.viewID) } }
                }
                .padding(12)
                Spacer(minLength: 0)
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(.background))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(Theme.divider)))
        .onHover { hover = $0 }
        .accessibilityIdentifier("dashboard.widget")
    }

    @ViewBuilder
    private func widgetBody(_ wctx: DBContext) -> some View {
        switch wctx.view.type {
        case .chart: ChartLayout(ctx: wctx, compact: true)
        case .board: BoardLayout(ctx: wctx)
        case .list: ListLayout(ctx: wctx)
        case .gallery: GalleryLayout(ctx: wctx)
        case .calendar: CalendarLayout(ctx: wctx)
        case .timeline: TimelineLayout(ctx: wctx)
        case .map: MapLayout(ctx: wctx, compact: true)
        default: TableLayout(ctx: wctx)
        }
    }

    private func header(_ view: DatabaseView, db: Database) -> some View {
        let store = model.store
        let otherDB = db.id != ctx.db.id
        return HStack(spacing: 6) {
            Image(systemName: view.type.symbol).font(.system(size: 12)).foregroundStyle(Theme.secondary)
            if renaming {
                TextField("Widget name", text: $name)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, weight: .medium))
                    .onSubmit {
                        let n = name.trimmingCharacters(in: .whitespaces)
                        if !n.isEmpty { store.updateView(view.id, name: "Rename widget") { $0.name = n } }
                        renaming = false
                    }
            } else {
                Text(view.name).font(.system(size: 14, weight: .medium)).lineLimit(1)
                    .onTapGesture(count: 2) { if !ctx.locked { name = view.name; renaming = true } }
            }
            if otherDB {
                Text(db.title.plainText.nonEmptyOr("Untitled")).font(.system(size: 12)).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            if hover && !ctx.locked { menu(view) }
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
    }

    private func menu(_ view: DatabaseView) -> some View {
        let store = model.store
        let dash = ctx.view.id
        return Menu {
            Button("Rename", systemImage: "pencil") { name = view.name; renaming = true }
            Menu("Layout") {
                ForEach(ViewType.widgetTypes, id: \.self) { t in
                    Button(t.displayName, systemImage: t.symbol) {
                        store.updateView(view.id, name: "Change widget layout") { v in
                            v.type = t
                            if t == .chart, v.chart == nil { v.chart = ChartConfig() }
                        }
                    }
                }
            }
            if view.type == .chart {
                Menu("Chart type") {
                    ForEach(ChartConfig.Kind.allCases, id: \.self) { k in
                        Button(k.displayName) { store.updateView(view.id, name: "Chart type") { v in var c = v.chart ?? ChartConfig(); c.kind = k; v.chart = c } }
                    }
                }
            }
            Menu("Data source") {
                ForEach(store.databases.values.sorted { $0.title.plainText < $1.title.plainText }, id: \.id) { db in
                    Button(db.title.plainText.nonEmptyOr("Untitled")) {
                        store.updateView(view.id, name: "Change data source") { v in
                            v.databaseID = db.id; v.filter = nil; v.sorts = nil; v.groupBy = nil; v.properties = nil
                            v.datePropertyID = db.properties.first { $0.type == .date }?.id
                            if var c = v.chart { c.xPropertyID = nil; c.yPropertyID = nil; v.chart = c }
                        }
                    }
                }
            }
            Menu("Width") {
                ForEach([3, 4, 6, 8, 9, 12], id: \.self) { w in
                    Button("\(w) / 12" + (w == widget.width ? " ✓" : "")) { store.setDashboardWidgetWidth(dash, widget: view.id, width: w) }
                }
            }
            Menu("Move") {
                if rowIndex > 0 { Button("Into row above") { store.moveDashboardWidget(dash, widget: view.id, toRow: rowIndex - 1) } }
                if rowIndex + 1 < rowCount { Button("Into row below") { store.moveDashboardWidget(dash, widget: view.id, toRow: rowIndex + 1) } }
                Button("To a new row above") { store.moveDashboardWidget(dash, widget: view.id, toRow: rowIndex, newRow: true) }
                Button("To a new row below") { store.moveDashboardWidget(dash, widget: view.id, toRow: rowIndex + 1, newRow: true) }
            }
            Button("Duplicate", systemImage: "plus.square.on.square") {
                if let id = store.addDashboardWidget(dash, type: view.type, databaseID: view.databaseID, rowIndex: rowFull ? rowIndex + 1 : rowIndex, newRow: rowFull) {
                    store.updateView(id, name: "Duplicate widget") { v in
                        let keep = v.id, of = v.widgetOf, block = v.blockID
                        v = view; v.id = keep; v.widgetOf = of; v.blockID = block; v.name = view.name + " (1)"
                    }
                }
            }
            Divider()
            Button("Remove widget", systemImage: "trash", role: .destructive) { store.removeDashboardWidget(dash, widget: view.id) }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary).frame(width: 22, height: 22)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityIdentifier("dashboard.widget.menu")
    }
}

/// "Add widget" menu: a view type over this database or any other.
struct AddWidgetMenu<Label: View>: View {
    let ctx: DBContext
    let rowIndex: Int?
    @ViewBuilder let label: () -> Label
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.store
        Menu {
            Section("This database") {
                ForEach(ViewType.widgetTypes, id: \.self) { t in
                    Button(t.displayName, systemImage: t.symbol) { add(t, db: nil) }
                }
            }
            let others = store.databases.values.filter { $0.id != ctx.db.id }.sorted { $0.title.plainText < $1.title.plainText }
            if !others.isEmpty {
                Menu("Other database") {
                    ForEach(others, id: \.id) { db in
                        Menu(db.title.plainText.nonEmptyOr("Untitled")) {
                            ForEach(ViewType.widgetTypes, id: \.self) { t in
                                Button(t.displayName, systemImage: t.symbol) { add(t, db: db.id) }
                            }
                        }
                    }
                }
            }
        } label: { label() }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private func add(_ t: ViewType, db: RecordID?) {
        model.store.addDashboardWidget(ctx.view.id, type: t, databaseID: db, rowIndex: rowIndex, newRow: rowIndex == nil)
    }
}
