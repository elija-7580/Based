import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#endif

/// Library: every page, database, row, memory, skill and file in one sortable table with search, filters,
/// multi-selection (checkboxes, ⇧-click ranges, ⌘/Ctrl-A) and bulk actions (Trash, Move to…, Duplicate,
/// Favorites, Export). Opened from the sidebar footer.
struct LibraryView: View {
    @Environment(AppModel.self) private var model
    @State private var query = LibraryQuery()
    @State private var selection: Set<RecordID> = []
    @State private var anchor: RecordID?
    @State private var cache: (revision: Int, items: [LibraryItem])?
    @State private var confirmDelete = false
    @FocusState private var tableFocused: Bool

    static let columns: [(LibrarySort, CGFloat?)] = [(.title, nil), (.kind, 96), (.location, 180), (.edited, 128), (.created, 128)]

    var body: some View {
        let _ = model.registry.workspace.revision
        let all = items()
        let rows = model.store.filterLibrary(all, query)
        let causes: [RecordID: String] = query.onlyDuplicateTitles
            ? Dictionary(model.store.duplicateTitleReport().flatMap { g in g.ids.map { ($0, g.cause.rawValue) } }, uniquingKeysWith: { a, _ in a })
            : [:]
        let visibleIDs = Set(rows.map(\.id))
        let selected = selection.intersection(visibleIDs)
        VStack(spacing: 0) {
            header(total: all.count, shown: rows.count)
            filterBar
            Rectangle().fill(Chrome.border).frame(height: 1)
            if !selected.isEmpty {
                LibraryActionBar(ids: rows.map(\.id).filter(selected.contains), clear: { selection = [] },
                                 delete: { confirmDelete = true })
            }
            columnHeader(rows: rows, selected: selected)
            if rows.isEmpty {
                ContentUnavailableView(all.isEmpty ? "Nothing here yet" : "No matches",
                                       systemImage: "books.vertical",
                                       description: Text(all.isEmpty ? "Pages, databases, memories and skills show up here." : "Try another search or clear the filters."))
                    .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(rows) { item in
                            LibraryRow(item: item, selected: selected.contains(item.id), note: causes[item.id],
                                       toggle: { toggle(item.id) },
                                       click: { click(item.id, rows: rows) },
                                       open: { open(item) })
                                .contextMenu { rowMenu(item, rows: rows, selected: selected) }
                        }
                    }
                    .padding(.bottom, 24)
                }
            }
        }
        .background(Chrome.appBackground)
        .focusable()
        .focused($tableFocused)
        .focusEffectDisabled()
        .onKeyPress(phases: .down) { press in
            // ⌘A (Mac) / Ctrl-A selects every visible row; Esc clears; ⌫ moves the selection to Trash.
            if press.characters == "a" && (press.modifiers.contains(.command) || press.modifiers.contains(.control)) {
                selection = visibleIDs
                return .handled
            }
            if press.key == .escape && !selection.isEmpty { selection = []; return .handled }
            if (press.key == .delete || press.key == .deleteForward) && !selected.isEmpty { confirmDelete = true; return .handled }
            return .ignored
        }
        .confirmationDialog(selected.count == 1 ? "Move 1 item to Trash?" : "Move \(selected.count) items to Trash?",
                            isPresented: $confirmDelete) {
            Button("Move to Trash", role: .destructive) {
                model.trash(rows.map(\.id).filter(selected.contains))
                selection = []
            }
        } message: { Text("Sub-pages go with their parent. You can undo or restore from Trash.") }
        .onAppear { tableFocused = true }
        .accessibilityIdentifier("library")
    }

    // MARK: Data

    private func items() -> [LibraryItem] {
        let rev = model.store.revision
        if let c = cache, c.revision == rev { return c.items }
        let brain = model.brain.brain
        let list = model.store.libraryItems(memoriesDB: brain.memoriesDB.isEmpty ? nil : brain.memoriesDB,
                                            skillsDB: brain.skillsDB.isEmpty ? nil : brain.skillsDB)
        DispatchQueue.main.async { cache = (rev, list) }
        return list
    }

    // MARK: Selection

    private func toggle(_ id: RecordID) {
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
        anchor = id
    }

    private func click(_ id: RecordID, rows: [LibraryItem]) {
        tableFocused = true
        #if os(macOS)
        let flags = NSEvent.modifierFlags
        if flags.contains(.shift), let a = anchor, let i = rows.firstIndex(where: { $0.id == a }), let j = rows.firstIndex(where: { $0.id == id }) {
            selection.formUnion(rows[min(i, j)...max(i, j)].map(\.id))
            return
        }
        if flags.contains(.command) { toggle(id); return }
        #endif
        selection = [id]
        anchor = id
    }

    private func open(_ item: LibraryItem) {
        if item.kind == .file, let p = item.parentID { model.open(p); return }
        model.open(item.id)
    }

    // MARK: Header & filters

    private func header(total: Int, shown: Int) -> some View {
        HStack(spacing: 10) {
            Text("Library").font(.system(size: 26, weight: .bold)).foregroundStyle(Theme.primary)
            Text(shown == total ? "\(total) items" : "\(shown) of \(total)")
                .font(.system(size: 13)).foregroundStyle(Chrome.sectionText)
            Spacer(minLength: 12)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Chrome.sectionText)
                TextField("Search titles and locations", text: $query.text)
                    .textFieldStyle(.plain).font(.system(size: 13))
                    .accessibilityIdentifier("library.search")
                if !query.text.isEmpty {
                    Button { query.text = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 11)) }
                        .buttonStyle(.plain).foregroundStyle(Chrome.sectionText)
                }
            }
            .padding(.horizontal, 8).frame(width: 260, height: 28)
            .background(RoundedRectangle(cornerRadius: 6).fill(Chrome.hover))
        }
        .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 10)
    }

    private var filterBar: some View {
        HStack(spacing: 6) {
            LibraryFilterChip(label: kindLabel, active: query.kinds.count < LibraryKind.allCases.count) {
                ForEach(LibraryKind.allCases, id: \.self) { k in
                    Toggle(k.rawValue, isOn: Binding(get: { query.kinds.contains(k) },
                                                     set: { on in if on { query.kinds.insert(k) } else { query.kinds.remove(k) } }))
                }
                Divider()
                Button("All types") { query.kinds = Set(LibraryKind.allCases) }
                Button("Pages and databases only") { query.kinds = [.page, .database] }
            }
            LibraryFilterChip(label: locationLabel, active: query.location != .any) {
                Button("Anywhere") { query.location = .any }
                Button("Top level only") { query.location = .topLevel }
                Button("Private") { query.location = .section(.privatePages) }
                ForEach(model.store.teamspaces) { t in Button(t.name) { query.location = .section(.teamspace(t.id)) } }
            }
            LibraryFilterChip(label: query.edited == .any ? "Edited" : "Edited: \(query.edited.rawValue)", active: query.edited != .any) {
                ForEach(LibraryDateFilter.allCases, id: \.self) { f in Button(f.rawValue) { query.edited = f } }
            }
            LibraryFilterChip(label: query.created == .any ? "Created" : "Created: \(query.created.rawValue)", active: query.created != .any) {
                ForEach(LibraryDateFilter.allCases, id: \.self) { f in Button(f.rawValue) { query.created = f } }
            }
            Button { query.onlyDuplicateTitles.toggle() } label: {
                Label("Same title", systemImage: "square.on.square")
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 8).frame(height: 24)
                    .background(Capsule().fill(query.onlyDuplicateTitles ? Chrome.accent.opacity(0.14) : Chrome.hover))
                    .foregroundStyle(query.onlyDuplicateTitles ? Chrome.accent : Chrome.sidebarText)
            }
            .buttonStyle(.plain)
            .help("Show only items whose title appears more than once")
            if isFiltered {
                Button("Clear filters") { let t = query.text; query = LibraryQuery(); query.text = t }
                    .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Chrome.sectionText)
            }
            Spacer()
        }
        .padding(.horizontal, 24).padding(.bottom, 10)
    }

    private var isFiltered: Bool {
        query.kinds.count < LibraryKind.allCases.count || query.location != .any || query.edited != .any || query.created != .any || query.onlyDuplicateTitles
    }

    private var kindLabel: String {
        if query.kinds.count == LibraryKind.allCases.count { return "Type" }
        if query.kinds.isEmpty { return "Type: none" }
        return "Type: " + LibraryKind.allCases.filter(query.kinds.contains).map(\.rawValue).joined(separator: ", ")
    }

    private var locationLabel: String {
        switch query.location {
        case .any: return "Location"
        case .topLevel: return "Location: Top level"
        case .section(.privatePages): return "Location: Private"
        case .section(.teamspace(let t)): return "Location: " + (model.store.teamspace(t)?.name ?? "Teamspace")
        case .parent(let p): return "In: " + model.store.title(of: p)
        }
    }

    private func columnHeader(rows: [LibraryItem], selected: Set<RecordID>) -> some View {
        HStack(spacing: 0) {
            LibraryCheckbox(state: selected.isEmpty ? .off : (selected.count == rows.count ? .on : .mixed)) {
                selection = selected.count == rows.count ? [] : Set(rows.map(\.id))
            }
            .help("Select all (⌘A)")
            .accessibilityIdentifier("library.selectAll")
            ForEach(Self.columns, id: \.0) { col, width in
                Button { sort(by: col) } label: {
                    HStack(spacing: 3) {
                        Text(col.rawValue)
                        if query.sort == col { Image(systemName: query.ascending ? "arrow.up" : "arrow.down").font(.system(size: 9, weight: .semibold)) }
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(query.sort == col ? Theme.primary : Chrome.sectionText)
                    .frame(maxWidth: width == nil ? .infinity : width, alignment: .leading)
                    .frame(width: width)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16).frame(height: 32)
        .overlay(alignment: .bottom) { Rectangle().fill(Chrome.border).frame(height: 1) }
    }

    private func sort(by col: LibrarySort) {
        if query.sort == col { query.ascending.toggle() } else {
            query.sort = col
            query.ascending = col == .title || col == .kind || col == .location
        }
    }

    // MARK: Context menu

    @ViewBuilder
    private func rowMenu(_ item: LibraryItem, rows: [LibraryItem], selected: Set<RecordID>) -> some View {
        let ids = selected.contains(item.id) && selected.count > 1 ? rows.map(\.id).filter(selected.contains) : [item.id]
        if ids.count == 1 {
            Button("Open", systemImage: "arrow.up.right.square") { open(item) }
            Button("Open in new tab", systemImage: "plus.rectangle.on.rectangle") { model.openInNewTab(item.kind == .file ? (item.parentID ?? item.id) : item.id) }
            if let p = item.parentID { Button("Show items in “\(model.store.title(of: p))”", systemImage: "line.3.horizontal.decrease") { query.location = .parent(p) } }
            Divider()
        } else {
            Text("\(ids.count) items selected")
        }
        Button("Move to…", systemImage: "arrow.turn.up.right") { model.moveRequest = AppModel.MoveRequest(ids: ids) }
        Button("Duplicate", systemImage: "plus.square.on.square") { model.duplicate(ids) }
        Button(ids.allSatisfy { model.store.isFavorite($0) } ? "Remove from Favorites" : "Add to Favorites", systemImage: "star") { model.toggleFavorite(ids) }
        Divider()
        Button(ids.count == 1 ? "Move to Trash" : "Move \(ids.count) items to Trash", systemImage: "trash", role: .destructive) {
            model.trash(ids)
            selection.subtract(ids)
        }
    }
}

/// Bulk action bar shown while rows are selected.
struct LibraryActionBar: View {
    let ids: [RecordID]
    let clear: () -> Void
    let delete: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let allFav = ids.allSatisfy { model.store.isFavorite($0) }
        HStack(spacing: 4) {
            Text("\(ids.count) selected")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(Chrome.accent)
                .padding(.trailing, 8)
                .accessibilityIdentifier("library.selectionCount")
            bar("Move to…", "arrow.turn.up.right") { model.moveRequest = AppModel.MoveRequest(ids: ids) }
            bar("Duplicate", "plus.square.on.square") { model.duplicate(ids) }
            bar(allFav ? "Unfavorite" : "Favorite", allFav ? "star.slash" : "star") { model.toggleFavorite(ids) }
            #if os(macOS)
            bar("Export", "square.and.arrow.up") { model.exportPagesWithPanel(ids) }
            #endif
            bar("Delete", "trash", destructive: true, action: delete)
                .accessibilityIdentifier("library.delete")
            Spacer()
            Button(action: clear) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 24, height: 24) }
                .buttonStyle(.plain).foregroundStyle(Chrome.sidebarText).help("Clear selection (Esc)")
        }
        .padding(.horizontal, 16).frame(height: 40)
        .background(Chrome.accent.opacity(0.07))
        .overlay(alignment: .bottom) { Rectangle().fill(Chrome.border).frame(height: 1) }
        .accessibilityIdentifier("library.actionBar")
    }

    private func bar(_ title: String, _ symbol: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        LibraryBarButton(title: title, symbol: symbol, destructive: destructive, action: action)
    }
}

struct LibraryBarButton: View {
    let title: String
    let symbol: String
    var destructive = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 8).frame(height: 28)
                .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Chrome.hover : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(destructive ? Color(Theme.dynamic(light: 0xEB5757, dark: 0xDF5452)) : Theme.primary)
        .onHover { hover = $0 }
    }
}

/// One Library row.
struct LibraryRow: View {
    let item: LibraryItem
    let selected: Bool
    /// "Same title" filter: why this row shares its title with others (see `DuplicateCause`).
    var note: String?
    let toggle: () -> Void
    let click: () -> Void
    let open: () -> Void
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        let block = model.store.blocks[item.id]
        HStack(spacing: 0) {
            LibraryCheckbox(state: selected ? .on : .off, visible: selected || hover, action: toggle)
            HStack(spacing: 8) {
                icon(block)
                Text(item.title.isEmpty ? "Untitled" : item.title)
                    .font(.system(size: 14)).foregroundStyle(Theme.primary).lineLimit(1).truncationMode(.tail)
                if item.isFavorite { Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(Chrome.sectionText) }
                Spacer(minLength: 6)
                if hover {
                    Button(action: open) {
                        Text("Open").font(.system(size: 11, weight: .medium)).padding(.horizontal, 6).frame(height: 20)
                            .background(RoundedRectangle(cornerRadius: 4).stroke(Chrome.border))
                    }
                    .buttonStyle(.plain).foregroundStyle(Chrome.sidebarText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(item.kind.rawValue)
                .font(.system(size: 12)).foregroundStyle(Chrome.sidebarText)
                .padding(.horizontal, 6).frame(height: 20)
                .background(RoundedRectangle(cornerRadius: 4).fill(kindColor.opacity(0.16)))
                .frame(width: 96, alignment: .leading)
            VStack(alignment: .leading, spacing: 0) {
                Text(item.location).font(.system(size: 13)).foregroundStyle(Chrome.sidebarText).lineLimit(1)
                if let note {
                    Text(note).font(.system(size: 11)).foregroundStyle(Color(Theme.dynamic(light: 0xD9730D, dark: 0xFFA344))).lineLimit(1)
                }
            }
            .help(note ?? item.location)
            .frame(width: 180, alignment: .leading)
            Text(Self.date(item.edited)).font(.system(size: 13)).foregroundStyle(Chrome.sidebarText).lineLimit(1)
                .frame(width: 128, alignment: .leading)
            Text(Self.date(item.created)).font(.system(size: 13)).foregroundStyle(Chrome.sidebarText).lineLimit(1)
                .frame(width: 128, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .frame(height: 34)
        .background(selected ? Chrome.accent.opacity(0.10) : (hover ? Chrome.hover.opacity(0.7) : .clear))
        .overlay(alignment: .bottom) { Rectangle().fill(Chrome.border.opacity(0.6)).frame(height: 1).padding(.leading, 16) }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(count: 2, perform: open)
        .onTapGesture(perform: click)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("library.row")
    }

    @ViewBuilder
    private func icon(_ b: Block?) -> some View {
        switch item.kind {
        case .file: Image(systemName: "paperclip").font(.system(size: 13)).frame(width: 18, height: 18).foregroundStyle(Chrome.sidebarText)
        case .memory: Image(systemName: "brain").font(.system(size: 13)).frame(width: 18, height: 18).foregroundStyle(Chrome.sidebarText)
        case .skill: Image(systemName: "wand.and.stars").font(.system(size: 13)).frame(width: 18, height: 18).foregroundStyle(Chrome.sidebarText)
        default: PageIconView(icon: b?.props.icon, isDatabase: item.kind == .database, size: 16).frame(width: 18, height: 18)
        }
    }

    private var kindColor: Color {
        switch item.kind {
        case .page: return .gray
        case .database: return .blue
        case .row: return .brown
        case .memory: return .purple
        case .skill: return .orange
        case .file: return .green
        }
    }

    static let formatter: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .none; f.doesRelativeDateFormatting = true; return f
    }()
    static func date(_ d: Date) -> String { formatter.string(from: d) }
}

enum CheckState { case off, on, mixed }

/// Notion-style 14 pt checkbox (hidden until hover unless checked).
struct LibraryCheckbox: View {
    let state: CheckState
    var visible = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 3)
                    .fill(state == .off ? Color.clear : Chrome.accent)
                RoundedRectangle(cornerRadius: 3)
                    .stroke(state == .off ? Chrome.sectionText : Chrome.accent, lineWidth: 1.2)
                if state != .off {
                    Image(systemName: state == .on ? "checkmark" : "minus").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                }
            }
            .frame(width: 14, height: 14)
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
            .opacity(visible || state != .off ? 1 : 0)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(state == .on ? "Selected" : "Select")
    }
}

/// Filter button that opens a menu ("Type", "Location: Private" …).
struct LibraryFilterChip<Items: View>: View {
    let label: String
    var active = false
    @ViewBuilder let items: () -> Items

    var body: some View {
        Menu { items() } label: {
            HStack(spacing: 4) {
                Text(label).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 8).frame(height: 24)
            .background(Capsule().fill(active ? Chrome.accent.opacity(0.14) : Chrome.hover))
            .foregroundStyle(active ? Chrome.accent : Chrome.sidebarText)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}
