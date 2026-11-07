import SwiftUI
import UniformTypeIdentifiers
import BasedCore

// MARK: - Display

/// Read-only rendering of a property value (cells, cards, list rows).
struct PropertyValueView: View {
    let property: PropertySchema
    let value: Value
    let row: Block
    var wrap = false
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.store
        switch property.type {
        case .select, .status:
            if case .select(let id)? = row.values[property.id], let o = property.option(id) { OptionPill(name: o.name, color: o.color) }
            else if case .status(let id)? = row.values[property.id], let o = property.option(id) { StatusPill(option: o, property: property) }
        case .multiSelect:
            if case .multiSelect(let ids)? = row.values[property.id] {
                FlowRow(wrap: wrap) { ForEach(ids, id: \.self) { id in if let o = property.option(id) { OptionPill(name: o.name, color: o.color) } } }
            }
        case .checkbox:
            TodoCheckbox(checked: value.bool)
        case .relation:
            if case .relation(let ids)? = row.values[property.id] {
                FlowRow(wrap: wrap) {
                    ForEach(ids, id: \.self) { id in
                        Button { model.open(id, mode: .centerPeek) } label: {
                            HStack(spacing: 3) {
                                PageIconView(icon: store.icon(of: id), size: 13)
                                Text(store.title(of: id)).underline(color: Theme.secondary.opacity(0.4))
                            }
                        }
                        .buttonStyle(.hoverFill)
                    }
                }
            }
        case .person, .createdBy, .lastEditedBy:
            let people = value.list.isEmpty && !value.isEmpty ? [value] : value.list
            FlowRow(wrap: wrap) {
                ForEach(Array(people.enumerated()), id: \.offset) { _, p in
                    Label(CellFormatter.text(p, store: store), systemImage: "person.crop.circle.fill")
                }
            }
        case .files:
            if case .files(let files)? = row.values[property.id] {
                FlowRow(wrap: wrap) { ForEach(Array(files.enumerated()), id: \.offset) { _, f in Label(f.name, systemImage: "paperclip") } }
            }
        case .url:
            if case .url(let u)? = row.values[property.id], !u.isEmpty {
                Link(u, destination: URL(string: u.contains("://") ? u : "https://" + u) ?? URL(string: "https://example.com")!)
                    .lineLimit(wrap ? nil : 1)
            }
        case .date, .createdTime, .lastEditedTime:
            if case .date(let d) = value { Text(Self.format(d, property)).lineLimit(1) }
        case .place:
            if case .place(let raw)? = row.values[property.id] {
                let v = PlaceValue(raw: raw)
                if !v.isEmpty {
                    Label(v.display, systemImage: v.hasCoordinates ? "mappin.and.ellipse" : "mappin").lineLimit(wrap ? nil : 1)
                }
            }
        case .number:
            if case .number(let n) = value { Text(CellFormatter.number(n, property.numberFormat)).monospacedDigit() }
        case .formula, .rollup:
            computed
        case .button:
            Text(property.name).padding(.horizontal, 6).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4).stroke(Color(Theme.divider)))
        default:
            Text(Self.displayText(CellFormatter.text(value, store: store))).lineLimit(wrap ? nil : 1)
        }
    }

    /// Imported text sometimes carries HTML ("<h2>Abstract</h2><p>…"): show it as plain text in cells.
    /// Display only — the stored value is untouched.
    static func displayText(_ s: String) -> String {
        guard s.contains("<"), s.range(of: #"</?[a-zA-Z][^>]*>"#, options: .regularExpression) != nil else { return s }
        var t = s.replacingOccurrences(of: #"<(br|/p|/h[1-6]|/li|/div)\s*/?>"#, with: " ", options: [.regularExpression, .caseInsensitive])
        t = t.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        for (e, c) in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", " ")] {
            t = t.replacingOccurrences(of: e, with: c)
        }
        return t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    @ViewBuilder
    private var computed: some View {
        switch value {
        case .bool(let b):
            TodoCheckbox(checked: b)
        case .number(let n):
            Text(CellFormatter.number(n, property.numberFormat)).monospacedDigit()
        case .date(let d):
            Text(DateDisplay.long(d))
        default:
            Text(CellFormatter.text(value, store: model.store)).lineLimit(wrap ? nil : 1)
        }
    }

    static func format(_ d: DateValue, _ p: PropertySchema) -> String {
        guard let fmt = p.dateFormat, !fmt.isEmpty else { return DateDisplay.long(d) }
        var s = DateDisplay.format(d.start, moment: fmt)
        if let e = d.end { s += " → " + DateDisplay.format(e, moment: fmt) }
        return s
    }
}

struct StatusPill: View {
    let option: SelectOption
    let property: PropertySchema
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.color(option.color.hue == .default ? .gray : option.color.hue)).frame(width: 7, height: 7)
            Text(option.name)
        }
        .font(.system(size: 13))
        .padding(.horizontal, 7).padding(.vertical, 1)
        .background(Capsule().fill(Theme.optionBackground(option.color.hue)))
    }
}

/// Horizontal list that wraps when asked (multi-select chips, relations…).
struct FlowRow<Content: View>: View {
    var wrap = false
    @ViewBuilder let content: () -> Content
    var body: some View {
        if wrap {
            WrapLayout(spacing: 4) { content() }
        } else {
            // Notion: pills keep their full width and the cell clips at its edge (instead of every pill
            // shrinking to "A…").
            HStack(spacing: 4) { content() }
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .frame(maxWidth: .infinity, alignment: .leading)
                .clipped()
        }
    }
}

/// Simple flow layout. An item wider than the available width gets exactly that width (its text wraps or
/// truncates) — measuring it at its ideal width made the row report a minimum wider than the cell, so the
/// stack laid it out too short and the next properties were drawn on top of it.
struct WrapLayout: Layout {
    var spacing: CGFloat = 4

    private func size(_ s: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let ideal = s.sizeThatFits(.unspecified)
        guard ideal.width > maxWidth, maxWidth.isFinite else { return ideal }
        return s.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = max(proposal.width ?? .infinity, 1)
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let sz = size(s, maxWidth: width)
            if x > 0, x + sz.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing
            maxX = max(maxX, x - spacing)
            rowH = max(rowH, sz.height)
        }
        return CGSize(width: min(maxX, width), height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let width = max(bounds.width, 1)
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = size(s, maxWidth: width)
            if x > bounds.minX, x + sz.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
    }
}

// MARK: - Editable cell

/// A property cell that opens the matching editor on click.
struct PropertyCell: View {
    let db: Database
    let row: Block
    let property: PropertySchema
    let value: Value
    var locked = false
    var wrap = false
    var placeholder = ""
    @Environment(AppModel.self) private var model
    @State private var editing = false

    private var editable: Bool { !locked && !property.type.isComputed && property.type != .title }

    var body: some View {
        Group {
            if property.type == .checkbox {
                Button {
                    model.store.setValue(row.id, property.id, .checkbox(!value.bool))
                } label: {
                    PropertyValueView(property: property, value: value, row: row)
                }
                .buttonStyle(.hoverFill)
                .frame(minWidth: 24, minHeight: 24)
                .contentShape(Rectangle())
                .disabled(locked)
            } else if wrap, editable, InlineScalarField.supports(property.type) {
                // Page property panel: type straight into text-like fields (Notion), no popover.
                InlineScalarField(rowID: row.id, property: property, placeholder: placeholder)
            } else {
                ZStack(alignment: .leading) {
                    if value.isEmpty && !placeholder.isEmpty {
                        Text(placeholder).foregroundStyle(Theme.secondary.opacity(0.6))
                    }
                    PropertyValueView(property: property, value: value, row: row, wrap: wrap)
                }
                .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { if editable { editing = true } }
                .popover(isPresented: $editing) {
                    PropertyValueEditor(db: db, rowID: row.id, property: property) { editing = false }
                        .environment(model)
                }
            }
        }
        .font(.system(size: 14))
    }
}

// MARK: - Editors

/// Text, number, URL, e-mail and phone values edited in place in a page's property panel.
/// Text is saved while typing; numbers on Return or when the field loses focus.
struct InlineScalarField: View {
    let rowID: RecordID
    let property: PropertySchema
    var placeholder = "Empty"
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var hover = false
    @FocusState private var focused: Bool

    static func supports(_ t: PropertyType) -> Bool { [.text, .number, .url, .email, .phone].contains(t) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...40)
                .focused($focused)
                .foregroundStyle(property.type == .url && !focused ? Color.accentColor : Theme.primary)
                .monospacedDigit()
                .onSubmit { commit(); focused = false }
                .onChange(of: draft) { _, _ in if property.type != .number && focused { commit() } }
                .onChange(of: focused) { _, f in if !f { commit() } }
                .accessibilityIdentifier("prop.inline.\(property.name)")
            if property.type == .url, hover, let url = linkURL {
                Link(destination: url) { Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .medium)) }
                    .help("Open link")
            }
        }
        .padding(.horizontal, 4).padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: 5).fill(focused ? Theme.hoverFill.opacity(0.6) : hover ? Theme.hoverFill : .clear))
        .padding(.horizontal, -4)
        .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { focused = true }
        .onAppear { draft = stored }
        .onChange(of: stored) { _, v in if !focused, v != draft { draft = v } }
    }

    private var stored: String {
        guard let v = model.store.blocks[rowID]?.values[property.id] else { return "" }
        if property.type == .number, case .number(let n) = v { return CellFormatter.number(n, property.numberFormat) }
        return v.plainString(property)
    }

    private var linkURL: URL? {
        let u = draft.trimmingCharacters(in: .whitespaces)
        guard !u.isEmpty else { return nil }
        return URL(string: u.contains("://") ? u : "https://" + u)
    }

    private func commit() {
        guard draft != stored else { return }
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let v: PropertyValue?
        switch property.type {
        case .number:
            let cleaned = t.replacingOccurrences(of: ",", with: "").filter { "0123456789.-eE".contains($0) }
            v = t.isEmpty ? nil : Double(cleaned).map { property.numberFormat == .percent && t.hasSuffix("%") ? .number($0 / 100) : .number($0) }
            if !t.isEmpty, v == nil { draft = stored; return }
        case .url: v = t.isEmpty ? nil : .url(t)
        case .email: v = t.isEmpty ? nil : .email(t)
        case .phone: v = t.isEmpty ? nil : .phone(t)
        default: v = draft.isEmpty ? nil : .text(RichText(draft))
        }
        model.store.setValue(rowID, property.id, v)
    }
}


/// Popover editor for one property value of one row.
struct PropertyValueEditor: View {
    let db: Database
    let rowID: RecordID
    let property: PropertySchema
    let done: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch property.type {
            case .select, .multiSelect, .status:
                OptionsEditor(db: db, rowID: rowID, property: property, done: done)
            case .date:
                DateEditor(rowID: rowID, property: property)
            case .relation:
                RelationEditor(rowID: rowID, property: property)
            case .files:
                FilesEditor(rowID: rowID, property: property)
            case .person:
                PersonEditor(rowID: rowID, property: property)
            case .number:
                ScalarEditor(rowID: rowID, property: property, done: done)
            case .place:
                PlaceEditor(rowID: rowID, property: property, done: done)
            default:
                ScalarEditor(rowID: rowID, property: property, done: done)
            }
        }
        .padding(10)
    }
}

/// Text, number, URL, email, phone, place.
struct ScalarEditor: View {
    let rowID: RecordID
    let property: PropertySchema
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var draft = ""

    var body: some View {
        TextField(property.name, text: $draft, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .lineLimit(1...16)
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.hoverFill.opacity(0.5)))
            .frame(width: 380)
            .onSubmit { commit(); done() }
            .onChange(of: draft) { _, _ in if property.type != .number { commit() } }
            .onDisappear { commit() }
            .onAppear { draft = initial }
    }

    private var initial: String {
        guard let v = model.store.blocks[rowID]?.values[property.id] else { return "" }
        return v.plainString(property)
    }

    private func commit() {
        let s = draft
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        let v: PropertyValue?
        switch property.type {
        case .number:
            let cleaned = t.replacingOccurrences(of: ",", with: "").filter { "0123456789.-eE".contains($0) }
            v = t.isEmpty ? nil : Double(cleaned).map { property.numberFormat == .percent && t.hasSuffix("%") ? .number($0 / 100) : .number($0) }
            if !t.isEmpty, v == nil { return }
        case .url: v = t.isEmpty ? nil : .url(t)
        case .email: v = t.isEmpty ? nil : .email(t)
        case .phone: v = t.isEmpty ? nil : .phone(t)
        case .place: v = t.isEmpty ? nil : .place(t)
        default: v = s.isEmpty ? nil : .text(RichText(s))
        }
        model.store.setValue(rowID, property.id, v)
    }
}

/// Select / multi-select / status option picker with search-to-create.
struct OptionsEditor: View {
    let db: Database
    let rowID: RecordID
    let property: PropertySchema
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var store: WorkspaceStore { model.store }
    private var schema: PropertySchema { store.databases[db.id]?.property(property.id) ?? property }
    private var selected: [String] {
        switch store.blocks[rowID]?.values[property.id] {
        case .select(let id)?, .status(let id)?: return [id]
        case .multiSelect(let ids)?: return ids
        default: return []
        }
    }

    var body: some View {
        let _ = model.registry.database(db.id).revision
        let s = schema
        let q = query.trimmingCharacters(in: .whitespaces)
        let options = (s.options ?? []).filter { q.isEmpty || $0.name.localizedCaseInsensitiveContains(q) }
        VStack(alignment: .leading, spacing: 6) {
            FlowRow(wrap: true) {
                ForEach(selected, id: \.self) { id in
                    if let o = s.option(id) {
                        HStack(spacing: 2) {
                            OptionPill(name: o.name, color: o.color)
                            Button { toggle(id) } label: { Image(systemName: "xmark").font(.system(size: 9)) }.buttonStyle(.quiet(padding: 1, minSize: 14))
                        }
                    }
                }
            }
            TextField(selected.isEmpty ? "Search for an option…" : "", text: $query)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    if let first = options.first, q.isEmpty || first.name.compare(q, options: .caseInsensitive) == .orderedSame || options.count == 1 { toggle(first.id) }
                    else if !q.isEmpty { create(q) }
                }
            Text(s.type == .status ? "Select status" : "Select an option or create one").font(.caption).foregroundStyle(Theme.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if s.type == .status, let groups = s.statusGroups {
                        ForEach(groups) { g in
                            Text(g.name).font(.caption).foregroundStyle(Theme.secondary).padding(.top, 6)
                            ForEach(options.filter { g.optionIDs.contains($0.id) }) { o in optionRow(o) }
                        }
                    } else {
                        ForEach(options) { o in optionRow(o) }
                    }
                    if !q.isEmpty, !(s.options ?? []).contains(where: { $0.name.compare(q, options: .caseInsensitive) == .orderedSame }) {
                        Button { create(q) } label: {
                            HStack { Text("Create"); OptionPill(name: q, color: .default); Spacer() }
                        }
                        .buttonStyle(MenuRowStyle())
                    }
                }
            }
            .frame(maxHeight: 260)
        }
        .frame(width: 280)
    }

    private func optionRow(_ o: SelectOption) -> some View {
        Button { toggle(o.id) } label: {
            HStack {
                OptionPill(name: o.name, color: o.color)
                Spacer()
                if selected.contains(o.id) { Image(systemName: "checkmark").font(.caption) }
            }
        }
        .buttonStyle(MenuRowStyle())
        .contextMenu {
            Menu("Color") {
                ForEach(TColor.textColors, id: \.self) { c in
                    Button(c.displayName) { store.updateOption(db.id, property.id, o.id) { $0.color = c } }
                }
            }
            Button("Delete", role: .destructive) { store.deleteOption(db.id, property.id, o.id) }
        }
    }

    private func toggle(_ id: String) {
        switch property.type {
        case .select:
            store.setValue(rowID, property.id, selected == [id] ? nil : .select(id))
            done()
        case .status:
            store.setValue(rowID, property.id, .status(id))
            done()
        default:
            var ids = selected
            if let i = ids.firstIndex(of: id) { ids.remove(at: i) } else { ids.append(id) }
            store.setValue(rowID, property.id, ids.isEmpty ? nil : .multiSelect(ids))
        }
        query = ""
    }

    private func create(_ name: String) {
        guard let id = store.addOption(db.id, property.id, name: name) else { return }
        toggle(id)
    }
}

struct DateEditor: View {
    let rowID: RecordID
    let property: PropertySchema
    @Environment(AppModel.self) private var model

    private var current: DateValue? {
        if case .date(let d)? = model.store.blocks[rowID]?.values[property.id] { return d }
        return nil
    }

    var body: some View {
        let _ = model.registry.block(rowID).block
        let d = current
        VStack(alignment: .leading, spacing: 8) {
            DatePicker("Start", selection: Binding(get: { d?.start ?? Date() }, set: { set(start: $0) }),
                       displayedComponents: d?.includeTime == true ? [.date, .hourAndMinute] : [.date])
                .datePickerStyle(.graphical)
                .labelsHidden()
            if let e = d?.end {
                DatePicker("End date", selection: Binding(get: { e }, set: { set(end: $0) }),
                           displayedComponents: d?.includeTime == true ? [.date, .hourAndMinute] : [.date])
            }
            Toggle("End date", isOn: Binding(get: { d?.end != nil }, set: { on in
                update { $0.end = on ? Calendar.current.date(byAdding: .day, value: 1, to: $0.start) : nil }
            }))
            Toggle("Include time", isOn: Binding(get: { d?.includeTime == true }, set: { on in update { $0.includeTime = on } }))
            Toggle("Remind", isOn: Binding(get: { d?.remind == true }, set: { on in update { $0.remind = on ? true : nil } }))
            HStack {
                Button("Today") { set(start: Calendar.current.startOfDay(for: Date())) }
                Spacer()
                Button("Clear", role: .destructive) { model.store.setValue(rowID, property.id, nil) }
            }
        }
        .frame(width: 280)
    }

    private func update(_ f: (inout DateValue) -> Void) {
        var d = current ?? DateValue(start: Calendar.current.startOfDay(for: Date()))
        f(&d)
        model.store.setValue(rowID, property.id, .date(d))
    }

    private func set(start: Date) {
        update { d in
            let delta = d.end.map { $0.timeIntervalSince(d.start) }
            d.start = start
            if let delta { d.end = start.addingTimeInterval(max(0, delta)) }
        }
    }

    private func set(end: Date) { update { $0.end = max(end, $0.start) } }
}

struct RelationEditor: View {
    let rowID: RecordID
    let property: PropertySchema
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var store: WorkspaceStore { model.store }
    private var selected: [RecordID] {
        if case .relation(let ids)? = store.blocks[rowID]?.values[property.id] { return ids }
        return []
    }

    var body: some View {
        let _ = model.registry.workspace.revision
        let target = property.relation?.databaseID
        let rows = target.map { store.rows(of: $0).filter { $0.props.isTemplate != true } } ?? []
        let q = query.trimmingCharacters(in: .whitespaces)
        let candidates = rows.filter { !selected.contains($0.id) && (q.isEmpty || $0.title.localizedCaseInsensitiveContains(q)) }
        VStack(alignment: .leading, spacing: 6) {
            TextField("Link or create a page…", text: $query).textFieldStyle(.roundedBorder)
                .onSubmit { if let first = candidates.first { add(first.id) } else if !q.isEmpty { create(q) } }
            if !selected.isEmpty {
                Text("\(selected.count) linked").font(.caption).foregroundStyle(Theme.secondary)
                ForEach(selected, id: \.self) { id in
                    HStack {
                        PageIconView(icon: store.icon(of: id), size: 14)
                        Text(store.title(of: id)).lineLimit(1)
                        Spacer()
                        Button { remove(id) } label: { Image(systemName: "minus.circle") }.buttonStyle(.quiet)
                    }
                    .padding(.vertical, 2)
                }
                Divider()
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(candidates.prefix(60), id: \.id) { r in
                        Button { add(r.id) } label: {
                            HStack { PageIconView(icon: r.props.icon, size: 14); Text(store.title(of: r.id)).lineLimit(1); Spacer() }
                        }
                        .buttonStyle(MenuRowStyle())
                    }
                    if !q.isEmpty {
                        Button { create(q) } label: { Label("New page \"\(q)\"", systemImage: "plus") }
                            .buttonStyle(MenuRowStyle())
                    }
                }
            }
            .frame(maxHeight: 240)
            if target == nil { Text("Choose a related database in the property settings.").font(.caption) }
        }
        .frame(width: 300)
    }

    private func add(_ id: RecordID) {
        let ids = property.relation?.limitOne == true ? [id] : selected + [id]
        store.setRelation(rowID, property.id, ids)
        query = ""
    }

    private func remove(_ id: RecordID) { store.setRelation(rowID, property.id, selected.filter { $0 != id }) }

    private func create(_ title: String) {
        guard let target = property.relation?.databaseID else { return }
        let id = store.addRow(to: target, title: RichText(title))
        add(id)
    }
}

struct FilesEditor: View {
    let rowID: RecordID
    let property: PropertySchema
    @Environment(AppModel.self) private var model
    @State private var link = ""
    @State private var importing = false

    private var files: [FileValue] {
        if case .files(let f)? = model.store.blocks[rowID]?.values[property.id] { return f }
        return []
    }

    var body: some View {
        let _ = model.registry.block(rowID).block
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(files.enumerated()), id: \.offset) { i, f in
                HStack {
                    Image(systemName: "paperclip")
                    if let u = f.url, let url = URL(string: u) { Link(f.name, destination: url) } else { Text(f.name) }
                    Spacer()
                    Button { var list = files; list.remove(at: i); save(list) } label: { Image(systemName: "trash") }.buttonStyle(.quiet)
                }
            }
            Button("Upload file…") { importing = true }
            HStack {
                TextField("Paste a link", text: $link).textFieldStyle(.roundedBorder)
                Button("Add") {
                    let l = link.trimmingCharacters(in: .whitespaces)
                    guard !l.isEmpty else { return }
                    save(files + [FileValue(name: URL(string: l)?.lastPathComponent ?? l, url: l)])
                    link = ""
                }
            }
        }
        .frame(width: 300)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            let added = urls.compactMap { u in AssetImport.importFile(u, into: model.assets).map { FileValue(name: u.lastPathComponent, asset: $0) } }
            save(files + added)
        }
    }

    private func save(_ list: [FileValue]) { model.store.setValue(rowID, property.id, list.isEmpty ? nil : .files(list)) }
}

struct PersonEditor: View {
    let rowID: RecordID
    let property: PropertySchema
    @Environment(AppModel.self) private var model
    @State private var name = ""

    private var people: [String] {
        if case .person(let p)? = model.store.blocks[rowID]?.values[property.id] { return p }
        return []
    }

    var body: some View {
        let _ = model.registry.block(rowID).block
        let me = model.store.userID ?? "me"
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Me", isOn: Binding(get: { people.contains(me) }, set: { on in
                save(on ? people + [me] : people.filter { $0 != me })
            }))
            ForEach(people.filter { $0 != me }, id: \.self) { p in
                HStack {
                    Label(p, systemImage: "person.crop.circle")
                    Spacer()
                    Button { save(people.filter { $0 != p }) } label: { Image(systemName: "xmark") }.buttonStyle(.quiet)
                }
            }
            TextField("Add a person…", text: $name).textFieldStyle(.roundedBorder)
                .onSubmit {
                    let n = name.trimmingCharacters(in: .whitespaces)
                    if !n.isEmpty, !people.contains(n) { save(people + [n]) }
                    name = ""
                }
        }
        .frame(width: 240)
    }

    private func save(_ list: [String]) { model.store.setValue(rowID, property.id, list.isEmpty ? nil : .person(list)) }
}