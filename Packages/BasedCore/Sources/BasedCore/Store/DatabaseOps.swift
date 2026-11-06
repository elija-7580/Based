import Foundation

public struct CreatedDatabase: Sendable {
    public var blockID: RecordID
    public var databaseID: RecordID
    public var viewID: RecordID
}

@MainActor
public extension WorkspaceStore {

    // MARK: Create

    /// Creates a database inline (in a page's content) or as a full page.
    @discardableResult
    func createDatabase(title: RichText = RichText(), in parent: ParentRef, at position: InsertPosition = .end,
                        inline: Bool, viewType: ViewType = .table, sampleRows: Int = 3) -> CreatedDatabase {
        transact("New database") { tx in
            let blockID = RecordIDs.make()
            var props: [PropertySchema] = [PropertySchema(id: Database.titlePropertyID, name: "Name", type: .title)]
            var groupBy: String?
            var dateProp: String?
            switch viewType {
            case .board:
                let status = PropertySchema(name: "Status", type: .status)
                props.append(status); groupBy = status.id
            case .calendar, .timeline:
                let date = PropertySchema(name: "Date", type: .date)
                props.append(date); dateProp = date.id
                props.append(PropertySchema(name: "Tags", type: .multiSelect))
            default:
                props.append(PropertySchema(name: "Tags", type: .multiSelect))
            }
            let db = Database(blockID: blockID, title: title, properties: props)
            tx.put(db)
            var view = DatabaseView(databaseID: db.id, blockID: blockID, name: viewType.defaultViewName,
                                    type: viewType, sortKey: FractionalIndex.between(nil, nil))
            if let groupBy { view.groupBy = GroupRule(propertyID: groupBy) }
            view.datePropertyID = dateProp
            if viewType == .gallery { view.cardCover = .pageContent }
            tx.put(view)
            var bprops = BlockProps()
            bprops.databaseID = db.id
            bprops.viewIDs = [view.id]
            let block = Block(id: blockID, type: inline ? .databaseInline : .databasePage, parent: parent,
                              sortKey: tx.sortKey(in: parent, position), props: bprops, createdBy: userID)
            tx.put(block)
            if sampleRows > 0, viewType != .calendar, viewType != .timeline {
                let keys = FractionalIndex.keys(count: sampleRows, between: nil, nil)
                for k in keys {
                    tx.put(Block(type: .page, parent: .database(db.id), sortKey: k, createdBy: userID))
                }
            }
            return CreatedDatabase(blockID: blockID, databaseID: db.id, viewID: view.id)
        }
    }

    /// "Linked view of database": a block showing an existing database with its own views.
    @discardableResult
    func createLinkedView(of databaseID: RecordID, in parent: ParentRef, at position: InsertPosition = .end,
                          type: ViewType = .table) -> RecordID? {
        guard databases[databaseID] != nil else { return nil }
        return transact("Linked view") { tx in
            let blockID = RecordIDs.make()
            let view = DatabaseView(databaseID: databaseID, blockID: blockID, name: type.defaultViewName, type: type,
                                    sortKey: FractionalIndex.between(nil, nil))
            tx.put(view)
            var p = BlockProps()
            p.databaseID = databaseID
            p.viewIDs = [view.id]
            tx.put(Block(id: blockID, type: .databaseInline, parent: parent, sortKey: tx.sortKey(in: parent, position),
                         props: p, createdBy: userID))
            return blockID
        }
    }

    func database(forBlock id: RecordID) -> Database? {
        blocks[id]?.props.databaseID.flatMap { databases[$0] }
    }

    /// The database a row belongs to.
    func database(ofRow id: RecordID) -> Database? {
        guard let b = blocks[id], case .database(let did) = b.parent else { return nil }
        return databases[did]
    }

    func rows(of databaseID: RecordID) -> [Block] {
        childBlocks(of: .database(databaseID)).filter { $0.trashedAt == nil }
    }

    func setDatabaseTitle(_ id: RecordID, _ title: RichText) {
        guard databases[id] != nil else { return }
        transact("Rename database", coalesce: "dbtitle:\(id)") { tx in tx.updateDatabase(id) { $0.title = title } }
    }

    func updateDatabase(_ id: RecordID, name: String = "Edit database", _ f: (inout Database) -> Void) {
        guard databases[id] != nil else { return }
        transact(name) { tx in tx.updateDatabase(id, f) }
    }

    // MARK: Rows

    @discardableResult
    func addRow(to databaseID: RecordID, title: RichText = RichText(), values: [String: PropertyValue] = [:],
                at position: InsertPosition = .end, template: RecordID? = nil) -> RecordID {
        let tpl = template ?? databases[databaseID]?.defaultTemplateID
        if let tpl, let src = blocks[tpl] {
            return transact("New row") { tx in
                let key = tx.sortKey(in: .database(databaseID), position)
                let id = copySubtree(src, parent: .database(databaseID), sortKey: key, tx: tx)
                tx.update(id) { b in
                    b.props.isTemplate = nil
                    if !title.isEmpty { b.text = title }
                    for (k, v) in values { b.values[k] = v }
                }
                if let db = tx.database(databaseID), let uid = db.properties.first(where: { $0.type == .uniqueID }) {
                    let next = db.nextUniqueID ?? 1
                    tx.update(id) { $0.values[uid.id] = .uniqueID(next) }
                    tx.updateDatabase(databaseID) { $0.nextUniqueID = next + 1 }
                }
                return id
            }
        }
        return createPage(title: title, in: .database(databaseID), at: position, values: values, name: "New row")
    }

    func setValue(_ rowID: RecordID, _ propertyID: String, _ value: PropertyValue?) {
        guard let b = blocks[rowID] else { return }
        if propertyID == Database.titlePropertyID || database(ofRow: rowID)?.property(propertyID)?.type == .title {
            if case .text(let t) = value { setText(rowID, t) } else if value == nil { setText(rowID, RichText()) }
            return
        }
        guard b.values[propertyID] != value else { return }
        let coalesce: String? = {
            switch value {
            case .text, .number, .url, .email, .phone, .place: return "value:\(rowID):\(propertyID)"
            default: return nil
            }
        }()
        transact("Edit property", coalesce: coalesce) { tx in
            tx.update(rowID) { $0.values[propertyID] = value }
        }
    }

    /// Templates are rows flagged `isTemplate`; they never appear in views.
    @discardableResult
    func addTemplate(to databaseID: RecordID, title: RichText = "New template") -> RecordID {
        transact("New template") { tx in
            var p = BlockProps()
            p.isTemplate = true
            let b = Block(type: .page, parent: .database(databaseID), sortKey: tx.sortKey(in: .database(databaseID), .end),
                          text: title, props: p, createdBy: userID)
            tx.put(b)
            tx.updateDatabase(databaseID) { $0.templateIDs = ($0.templateIDs ?? []) + [b.id] }
            return b.id
        }
    }

    func templates(of databaseID: RecordID) -> [Block] {
        rows(of: databaseID).filter { $0.props.isTemplate == true }
    }

    // MARK: Properties

    @discardableResult
    func addProperty(to databaseID: RecordID, name: String, type: PropertyType, after: String? = nil,
                     showIn viewID: RecordID? = nil) -> String? {
        guard let db = databases[databaseID] else { return nil }
        var prop = PropertySchema(name: uniquePropertyName(name, in: db), type: type)
        if type == .formula { prop.formula = "" }
        if type == .uniqueID { prop.idPrefix = nil }
        let rowsToNumber = type == .uniqueID ? rows(of: databaseID).sorted { $0.createdAt < $1.createdAt } : []
        return transact("Add property") { tx in
            tx.updateDatabase(databaseID) { d in
                if let after, let i = d.properties.firstIndex(where: { $0.id == after }) {
                    d.properties.insert(prop, at: i + 1)
                } else {
                    d.properties.append(prop)
                }
                if type == .uniqueID { d.nextUniqueID = rowsToNumber.count + 1 }
            }
            for (i, r) in rowsToNumber.enumerated() { tx.update(r.id) { $0.values[prop.id] = .uniqueID(i + 1) } }
            if let viewID, let v = tx.view(viewID) {
                tx.updateView(viewID) { view in
                    var list = view.properties ?? v.visiblePropertyIDs(in: db).map { ViewProperty(id: $0) }
                    list.removeAll { $0.id == prop.id }
                    if let after, let i = list.firstIndex(where: { $0.id == after }) {
                        list.insert(ViewProperty(id: prop.id), at: i + 1)
                    } else {
                        list.append(ViewProperty(id: prop.id))
                    }
                    view.properties = list
                }
            }
            return prop.id
        }
    }

    func uniquePropertyName(_ name: String, in db: Database) -> String {
        var candidate = name
        var n = 1
        while db.property(named: candidate) != nil { n += 1; candidate = "\(name) \(n)" }
        return candidate
    }

    func updateProperty(_ databaseID: RecordID, _ propertyID: String, name: String = "Edit property",
                        _ f: (inout PropertySchema) -> Void) {
        guard let db = databases[databaseID], db.property(propertyID) != nil else { return }
        transact(name) { tx in
            tx.updateDatabase(databaseID) { d in
                if let i = d.properties.firstIndex(where: { $0.id == propertyID }) { f(&d.properties[i]) }
            }
        }
    }

    func renameProperty(_ databaseID: RecordID, _ propertyID: String, to name: String) {
        updateProperty(databaseID, propertyID, name: "Rename property") { $0.name = name }
    }

    func deleteProperty(_ databaseID: RecordID, _ propertyID: String) {
        guard let db = databases[databaseID], let p = db.property(propertyID), p.type != .title else { return }
        let affectedViews = views.values.filter { $0.databaseID == databaseID }
        transact("Delete property") { tx in
            tx.updateDatabase(databaseID) { $0.properties.removeAll { $0.id == propertyID } }
            for v in affectedViews {
                tx.updateView(v.id) { view in
                    view.properties?.removeAll { $0.id == propertyID }
                    view.sorts?.removeAll { $0.propertyID == propertyID }
                    if view.groupBy?.propertyID == propertyID { view.groupBy = nil }
                    if view.datePropertyID == propertyID { view.datePropertyID = nil }
                    if view.endDatePropertyID == propertyID { view.endDatePropertyID = nil }
                    if view.mapPropertyID == propertyID { view.mapPropertyID = nil }
                    view.calculations?[propertyID] = nil
                    if let f = view.filter { view.filter = f.removing(propertyID: propertyID) }
                }
            }
            for r in rows(of: databaseID) where r.values[propertyID] != nil {
                tx.update(r.id) { $0.values[propertyID] = nil }
            }
        }
    }

    @discardableResult
    func duplicateProperty(_ databaseID: RecordID, _ propertyID: String) -> String? {
        guard let db = databases[databaseID], var p = db.property(propertyID), p.type != .title else { return nil }
        let old = p.id
        p.id = RecordIDs.make()
        p.name = uniquePropertyName(p.name, in: db)
        let copy = p
        return transact("Duplicate property") { tx in
            tx.updateDatabase(databaseID) { d in
                let i = d.properties.firstIndex { $0.id == old } ?? d.properties.count - 1
                d.properties.insert(copy, at: i + 1)
            }
            for r in rows(of: databaseID) { if let v = r.values[old] { tx.update(r.id) { $0.values[copy.id] = v } } }
            return copy.id
        }
    }

    /// Change a property's type, converting existing values like Notion does.
    func changePropertyType(_ databaseID: RecordID, _ propertyID: String, to type: PropertyType) {
        guard let db = databases[databaseID], let old = db.property(propertyID), old.type != type,
              old.type != .title, type != .title else { return }
        var schema = old
        schema.type = type
        if type == .status { schema.applyDefaultStatus() }
        var options = (type == .select || type == .multiSelect || type == .status) ? (schema.options ?? []) : []
        if (type == .select || type == .multiSelect) && !(old.type == .select || old.type == .multiSelect || old.type == .status) {
            options = []
        }
        var converted: [RecordID: PropertyValue?] = [:]
        let palette = TColor.textColors
        for r in rows(of: databaseID) {
            guard let v = r.values[propertyID] else { continue }
            let names = v.optionNames(old)
            let text = v.plainString(old)
            var nv: PropertyValue?
            switch type {
            case .text: nv = text.isEmpty ? nil : .text(RichText(text))
            case .number: nv = Double(text.replacingOccurrences(of: ",", with: "")).map(PropertyValue.number)
            case .checkbox:
                let t = text.lowercased()
                nv = .checkbox(["true", "yes", "1", "checked", "x", "✓"].contains(t))
            case .url: nv = text.isEmpty ? nil : .url(text)
            case .email: nv = text.isEmpty ? nil : .email(text)
            case .phone: nv = text.isEmpty ? nil : .phone(text)
            case .place: nv = text.isEmpty ? nil : .place(text)
            case .date: nv = DateParsing.parse(text).map(PropertyValue.date)
            case .select, .multiSelect, .status:
                var ids: [String] = []
                for name in names where !name.isEmpty {
                    if let o = options.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
                        ids.append(o.id)
                    } else if type != .status {
                        let o = SelectOption(name: name, color: palette[(options.count + 1) % palette.count])
                        options.append(o); ids.append(o.id)
                    }
                }
                if type == .multiSelect { nv = ids.isEmpty ? nil : .multiSelect(ids) }
                else { nv = ids.first.map { type == .status ? .status($0) : .select($0) } }
            case .person: if case .person = v { nv = v }
            case .files: if case .files = v { nv = v }
            case .relation: if case .relation = v { nv = v }
            default: nv = nil
            }
            converted[r.id] = nv
        }
        if type == .select || type == .multiSelect { schema.options = options }
        if type != .select && type != .multiSelect && type != .status { schema.options = nil; schema.statusGroups = nil }
        if type == .formula, schema.formula == nil { schema.formula = "" }
        if type == .relation, schema.relation == nil { schema.relation = RelationConfig(databaseID: databaseID) }
        let final = schema
        transact("Change property type") { tx in
            tx.updateDatabase(databaseID) { d in
                if let i = d.properties.firstIndex(where: { $0.id == propertyID }) { d.properties[i] = final }
            }
            for (id, v) in converted { tx.update(id) { $0.values[propertyID] = v } }
        }
    }

    /// New select/multi-select/status option; colour cycles like Notion's random palette.
    @discardableResult
    func addOption(_ databaseID: RecordID, _ propertyID: String, name: String, color: TColor? = nil,
                   statusGroup: String? = nil) -> String? {
        guard let p = databases[databaseID]?.property(propertyID) else { return nil }
        if let existing = p.option(named: name) { return existing.id }
        let palette = TColor.textColors.filter { $0 != .default }
        let option = SelectOption(name: name, color: color ?? palette[(p.options?.count ?? 0) % palette.count])
        updateProperty(databaseID, propertyID, name: "Add option") { s in
            s.options = (s.options ?? []) + [option]
            if s.type == .status, var groups = s.statusGroups, !groups.isEmpty {
                let gi = groups.firstIndex { $0.id == statusGroup } ?? 0
                groups[gi].optionIDs.append(option.id)
                s.statusGroups = groups
            }
        }
        return option.id
    }

    func updateOption(_ databaseID: RecordID, _ propertyID: String, _ optionID: String, _ f: (inout SelectOption) -> Void) {
        updateProperty(databaseID, propertyID, name: "Edit option") { s in
            if let i = s.options?.firstIndex(where: { $0.id == optionID }) { f(&s.options![i]) }
        }
    }

    func deleteOption(_ databaseID: RecordID, _ propertyID: String, _ optionID: String) {
        guard databases[databaseID] != nil else { return }
        let affected = rows(of: databaseID)
        transact("Delete option") { tx in
            tx.updateDatabase(databaseID) { d in
                guard let i = d.properties.firstIndex(where: { $0.id == propertyID }) else { return }
                d.properties[i].options?.removeAll { $0.id == optionID }
                if var groups = d.properties[i].statusGroups {
                    for g in groups.indices { groups[g].optionIDs.removeAll { $0 == optionID } }
                    d.properties[i].statusGroups = groups
                }
            }
            for r in affected {
                switch r.values[propertyID] {
                case .select(let o) where o == optionID, .status(let o) where o == optionID:
                    tx.update(r.id) { $0.values[propertyID] = nil }
                case .multiSelect(let ids) where ids.contains(optionID):
                    let rest = ids.filter { $0 != optionID }
                    tx.update(r.id) { $0.values[propertyID] = rest.isEmpty ? nil : .multiSelect(rest) }
                default: break
                }
            }
        }
    }

    /// Two-way relation: creates the mirrored property on the target database.
    func makeRelationTwoWay(_ databaseID: RecordID, _ propertyID: String, name: String? = nil) {
        guard let db = databases[databaseID], let p = db.property(propertyID), let rel = p.relation,
              rel.syncedPropertyID == nil, let target = databases[rel.databaseID] else { return }
        var mirror = PropertySchema(name: name ?? uniquePropertyName("Related to \(db.title.plainText.isEmpty ? "Untitled" : db.title.plainText)", in: target),
                                    type: .relation)
        mirror.relation = RelationConfig(databaseID: databaseID, syncedPropertyID: propertyID)
        let m = mirror
        let sourceRows = rows(of: databaseID)
        transact("Two-way relation") { tx in
            tx.updateDatabase(target.id) { $0.properties.append(m) }
            tx.updateDatabase(databaseID) { d in
                if let i = d.properties.firstIndex(where: { $0.id == propertyID }) { d.properties[i].relation?.syncedPropertyID = m.id }
            }
            var back: [RecordID: [RecordID]] = [:]
            for r in sourceRows { if case .relation(let ids) = r.values[propertyID] { for t in ids { back[t, default: []].append(r.id) } } }
            for (t, ids) in back where tx.block(t) != nil { tx.update(t) { $0.values[m.id] = .relation(ids) } }
        }
    }

    /// Set relation targets, keeping the synced (two-way) property consistent.
    func setRelation(_ rowID: RecordID, _ propertyID: String, _ targets: [RecordID]) {
        guard let db = database(ofRow: rowID), let p = db.property(propertyID), let rel = p.relation else { return }
        let old: [RecordID] = { if case .relation(let ids) = blocks[rowID]?.values[propertyID] { return ids } else { return [] } }()
        let added = targets.filter { !old.contains($0) }
        let removed = old.filter { !targets.contains($0) }
        transact("Edit relation") { tx in
            tx.update(rowID) { $0.values[propertyID] = targets.isEmpty ? nil : .relation(targets) }
            guard let mirror = rel.syncedPropertyID else { return }
            for t in added where tx.block(t) != nil {
                tx.update(t) { b in
                    var ids: [RecordID] = { if case .relation(let x) = b.values[mirror] { return x } else { return [] } }()
                    if !ids.contains(rowID) { ids.append(rowID) }
                    b.values[mirror] = .relation(ids)
                }
            }
            for t in removed where tx.block(t) != nil {
                tx.update(t) { b in
                    var ids: [RecordID] = { if case .relation(let x) = b.values[mirror] { return x } else { return [] } }()
                    ids.removeAll { $0 == rowID }
                    b.values[mirror] = ids.isEmpty ? nil : .relation(ids)
                }
            }
        }
    }

    // MARK: Views

    @discardableResult
    func addView(to blockID: RecordID, type: ViewType, name: String? = nil) -> RecordID? {
        guard let b = blocks[blockID], let dbID = b.props.databaseID, let db = databases[dbID] else { return nil }
        if type == .dashboard { return addDashboard(to: blockID, db: db, name: name) }
        let existing = views(forBlock: blockID)
        var v = DatabaseView(databaseID: dbID, blockID: blockID, name: name ?? type.defaultViewName, type: type,
                             sortKey: FractionalIndex.between(existing.last?.sortKey, nil))
        switch type {
        case .board:
            v.groupBy = (db.properties.first { $0.type == .status } ?? db.properties.first { $0.type == .select })
                .map { GroupRule(propertyID: $0.id) }
        case .calendar, .timeline:
            v.datePropertyID = db.properties.first { $0.type == .date }?.id
        case .gallery:
            v.cardCover = .pageContent
        case .map:
            v.mapPropertyID = db.properties.first { $0.type == .place }?.id
        default: break
        }
        let view = v
        let needsDate = (type == .calendar || type == .timeline) && view.datePropertyID == nil
        let needsStatus = type == .board && view.groupBy == nil
        let needsPlace = type == .map && view.mapPropertyID == nil
        return transact("Add view") { tx in
            var vv = view
            if needsPlace {
                // Notion needs a Place property for map views — add one like it does.
                let p = PropertySchema(name: uniquePropertyName("Place", in: db), type: .place)
                tx.updateDatabase(dbID) { $0.properties.append(p) }
                vv.mapPropertyID = p.id
            }
            if needsDate {
                let p = PropertySchema(name: uniquePropertyName("Date", in: db), type: .date)
                tx.updateDatabase(dbID) { $0.properties.append(p) }
                vv.datePropertyID = p.id
            }
            if needsStatus {
                let p = PropertySchema(name: uniquePropertyName("Status", in: db), type: .status)
                tx.updateDatabase(dbID) { $0.properties.append(p) }
                vv.groupBy = GroupRule(propertyID: p.id)
            }
            tx.put(vv)
            tx.update(blockID) { $0.props.viewIDs = ($0.props.viewIDs ?? []) + [vv.id] }
            return vv.id
        }
    }

    func updateView(_ id: RecordID, name: String = "Edit view", _ f: (inout DatabaseView) -> Void) {
        guard views[id] != nil else { return }
        transact(name) { tx in tx.updateView(id, f) }
    }

    func deleteView(_ id: RecordID) {
        guard let v = views[id] else { return }
        if let dash = v.widgetOf { removeDashboardWidget(dash, widget: id); return }
        guard views(forBlock: v.blockID).count > 1 else { return }
        let widgets = v.dashboard?.widgetViewIDs ?? []
        transact("Delete view") { tx in
            tx.remove(RecordKey(.view, id))
            for w in widgets where views[w] != nil { tx.remove(RecordKey(.view, w)) }
            tx.update(v.blockID) { $0.props.viewIDs?.removeAll { $0 == id } }
        }
    }

    // MARK: Dashboards

    /// A widget view record (not listed in the block's view tabs) with sensible defaults for its type.
    func makeWidgetView(dashboard: DatabaseView, type: ViewType, db: Database, name: String? = nil) -> DatabaseView {
        var v = DatabaseView(databaseID: db.id, blockID: dashboard.blockID, name: name ?? type.defaultViewName, type: type,
                             sortKey: FractionalIndex.first)
        v.widgetOf = dashboard.id
        switch type {
        case .board:
            v.groupBy = (db.properties.first { $0.type == .status } ?? db.properties.first { $0.type == .select }).map { GroupRule(propertyID: $0.id) }
        case .calendar, .timeline:
            v.datePropertyID = db.properties.first { $0.type == .date }?.id
        case .gallery:
            v.cardCover = .pageContent
        case .map:
            v.mapPropertyID = db.properties.first { $0.type == .place }?.id
        case .chart:
            let x = db.properties.first { $0.type == .status } ?? db.properties.first { $0.type == .select }
                ?? db.properties.first { [.multiSelect, .checkbox, .date].contains($0.type) }
            v.chart = ChartConfig(kind: x == nil ? .number : .bar, xPropertyID: x?.id)
            if x == nil { v.name = "Total" }
        default: break
        }
        return v
    }

    /// New dashboard view: a "Total" number chart next to a chart by status/select, and a table below.
    private func addDashboard(to blockID: RecordID, db: Database, name: String?) -> RecordID? {
        let existing = views(forBlock: blockID)
        var dash = DatabaseView(databaseID: db.id, blockID: blockID, name: name ?? "Dashboard", type: .dashboard,
                                sortKey: FractionalIndex.between(existing.last?.sortKey, nil))
        var total = makeWidgetView(dashboard: dash, type: .chart, db: db, name: "Total")
        total.chart = ChartConfig(kind: .number)
        let chart = makeWidgetView(dashboard: dash, type: .chart, db: db, name: "By " + (db.properties.first { [.status, .select].contains($0.type) }?.name ?? "group"))
        let table = makeWidgetView(dashboard: dash, type: .table, db: db, name: db.title.plainText.isEmpty ? "Table" : db.title.plainText)
        var config = DashboardConfig()
        config.insert(total.id, rowIndex: nil, newRow: true)
        if chart.chart?.kind != .number { config.insert(chart.id, rowIndex: 0, newRow: false) }
        config.insert(table.id, rowIndex: nil, newRow: true)
        dash.dashboard = config
        let d = dash, ws = chart.chart?.kind != .number ? [total, chart, table] : [total, table]
        return transact("Add dashboard") { tx in
            for w in ws { tx.put(w) }
            tx.put(d)
            tx.update(blockID) { $0.props.viewIDs = ($0.props.viewIDs ?? []) + [d.id] }
            return d.id
        }
    }

    /// Adds a widget showing `databaseID` (default: the dashboard's database) to a dashboard: in a new row, or next
    /// to the widgets of row `rowIndex` (max. 4 per row).
    @discardableResult
    func addDashboardWidget(_ dashboardID: RecordID, type: ViewType, databaseID: RecordID? = nil,
                            rowIndex: Int? = nil, newRow: Bool = true) -> RecordID? {
        guard let dash = views[dashboardID], dash.type == .dashboard, ViewType.widgetTypes.contains(type),
              let db = databases[databaseID ?? dash.databaseID] else { return nil }
        let w = makeWidgetView(dashboard: dash, type: type, db: db)
        return transact("Add widget") { tx in
            tx.put(w)
            tx.updateView(dashboardID) { v in
                var c = v.dashboard ?? DashboardConfig()
                c.insert(w.id, rowIndex: rowIndex, newRow: newRow)
                v.dashboard = c
            }
            return w.id
        }
    }

    func removeDashboardWidget(_ dashboardID: RecordID, widget viewID: RecordID) {
        guard views[dashboardID] != nil else { return }
        transact("Remove widget") { tx in
            tx.updateView(dashboardID) { v in v.dashboard?.remove(viewID: viewID) }
            if views[viewID] != nil { tx.remove(RecordKey(.view, viewID)) }
        }
    }

    func setDashboardWidgetWidth(_ dashboardID: RecordID, widget viewID: RecordID, width: Int) {
        updateView(dashboardID, name: "Resize widget") { $0.dashboard?.setWidth(viewID: viewID, width) }
    }

    func moveDashboardWidget(_ dashboardID: RecordID, widget viewID: RecordID, toRow: Int, index: Int? = nil, newRow: Bool = false) {
        updateView(dashboardID, name: "Move widget") { $0.dashboard?.move(viewID: viewID, toRow: toRow, index: index, newRow: newRow) }
    }

    func setDashboardRowHeight(_ dashboardID: RecordID, row: String, height: Double?) {
        updateView(dashboardID, name: "Resize row") { v in
            guard let i = v.dashboard?.rows.firstIndex(where: { $0.id == row }) else { return }
            v.dashboard?.rows[i].height = height
        }
    }

    @discardableResult
    func duplicateView(_ id: RecordID) -> RecordID? {
        guard let v = views[id] else { return nil }
        let list = views(forBlock: v.blockID)
        let next = list.firstIndex { $0.id == id }.flatMap { $0 + 1 < list.count ? list[$0 + 1].sortKey : nil }
        var copy = v
        copy.id = RecordIDs.make()
        copy.name = v.name + " (1)"
        copy.sortKey = FractionalIndex.between(v.sortKey, next)
        let c = copy
        return transact("Duplicate view") { tx in
            tx.put(c)
            tx.update(v.blockID) { $0.props.viewIDs = ($0.props.viewIDs ?? []) + [c.id] }
            return c.id
        }
    }

    func moveView(_ id: RecordID, before other: RecordID?) {
        guard let v = views[id] else { return }
        let list = views(forBlock: v.blockID).filter { $0.id != id }
        let i = other.flatMap { o in list.firstIndex { $0.id == o } } ?? list.count
        let lo = i > 0 ? list[i - 1].sortKey : nil
        let hi = i < list.count ? list[i].sortKey : nil
        updateView(id, name: "Move view") { $0.sortKey = FractionalIndex.between(lo, hi) }
    }

    /// Show/hide a property in a view.
    func setPropertyVisible(_ viewID: RecordID, _ propertyID: String, _ visible: Bool) {
        guard let v = views[viewID], let db = databases[v.databaseID] else { return }
        updateView(viewID, name: visible ? "Show property" : "Hide property") { view in
            var list = view.properties ?? db.properties.map { ViewProperty(id: $0.id, visible: v.visiblePropertyIDs(in: db).contains($0.id)) }
            for p in db.properties where !list.contains(where: { $0.id == p.id }) {
                list.append(ViewProperty(id: p.id, visible: v.visiblePropertyIDs(in: db).contains(p.id)))
            }
            if let i = list.firstIndex(where: { $0.id == propertyID }) { list[i].visible = visible }
            view.properties = list
        }
    }

    /// Reorder visible properties of a view.
    func movePropertyInView(_ viewID: RecordID, _ propertyID: String, to index: Int) {
        guard let v = views[viewID], let db = databases[v.databaseID] else { return }
        updateView(viewID, name: "Move property") { view in
            let visible = Set(v.visiblePropertyIDs(in: db))
            var list = view.properties ?? db.properties.map { ViewProperty(id: $0.id, visible: visible.contains($0.id)) }
            for p in db.properties where !list.contains(where: { $0.id == p.id }) {
                list.append(ViewProperty(id: p.id, visible: visible.contains(p.id)))
            }
            guard let from = list.firstIndex(where: { $0.id == propertyID }) else { return }
            let item = list.remove(at: from)
            list.insert(item, at: max(0, min(index, list.count)))
            view.properties = list
        }
    }

    func setColumnWidth(_ viewID: RecordID, _ propertyID: String, _ width: Double) {
        guard let v = views[viewID], let db = databases[v.databaseID] else { return }
        transact("Resize column", coalesce: "width:\(viewID):\(propertyID)") { tx in
            tx.updateView(viewID) { view in
                let visible = Set(v.visiblePropertyIDs(in: db))
                var list = view.properties ?? db.properties.map { ViewProperty(id: $0.id, visible: visible.contains($0.id)) }
                if let i = list.firstIndex(where: { $0.id == propertyID }) { list[i].width = width }
                else { list.append(ViewProperty(id: propertyID, visible: true, width: width)) }
                view.properties = list
            }
        }
    }
}

public extension ViewType {
    var defaultViewName: String {
        switch self {
        case .table: return "Table"
        case .board: return "Board"
        case .list: return "List"
        case .gallery: return "Gallery"
        case .calendar: return "Calendar"
        case .timeline: return "Timeline"
        case .dashboard: return "Dashboard"
        default: return rawValue.capitalized
        }
    }
}

public extension FilterGroup {
    /// Drops conditions that reference a deleted property.
    func removing(propertyID: String) -> FilterGroup {
        var g = self
        g.items = items.compactMap { item in
            switch item {
            case .condition(let c): return c.propertyID == propertyID ? nil : item
            case .group(let sub):
                let s = sub.removing(propertyID: propertyID)
                return s.items.isEmpty ? nil : .group(s)
            }
        }
        return g
    }
}

public extension PropertyValue {
    /// Option names for select-like values; text split by commas otherwise.
    func optionNames(_ schema: PropertySchema) -> [String] {
        switch self {
        case .select(let id), .status(let id): return [schema.option(id)?.name ?? ""]
        case .multiSelect(let ids): return ids.compactMap { schema.option($0)?.name }
        default:
            return plainString(schema).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        }
    }

    /// Plain string form (used for conversions, search and CSV).
    func plainString(_ schema: PropertySchema?) -> String {
        switch self {
        case .text(let t): return t.plainText
        case .number(let n): return NumberFormatting.plain(n)
        case .select(let id), .status(let id): return schema?.option(id)?.name ?? ""
        case .multiSelect(let ids): return ids.compactMap { schema?.option($0)?.name }.joined(separator: ", ")
        case .date(let d): return DateParsing.format(d)
        case .person(let ids): return ids.joined(separator: ", ")
        case .files(let files): return files.map { $0.url ?? $0.name }.joined(separator: ", ")
        case .checkbox(let b): return b ? "Yes" : "No"
        case .url(let s), .email(let s), .phone(let s): return s
        case .place(let s): return PlaceValue.display(s)
        case .relation(let ids): return ids.joined(separator: ", ")
        case .uniqueID(let n): return (schema?.idPrefix.map { "\($0)-" } ?? "") + String(n)
        }
    }
}

public enum NumberFormatting {
    public static func plain(_ n: Double) -> String {
        if n.isNaN || n.isInfinite { return String(n) }
        if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        var s = String(format: "%.10f", n)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }
}

public enum DateParsing {
    static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    static let isoMinute: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()
    static let notionLong: [DateFormatter] = ["MMMM d, yyyy h:mm a", "MMMM d, yyyy", "MMM d, yyyy", "d MMMM yyyy",
                                              "dd.MM.yyyy", "MM/dd/yyyy", "yyyy/MM/dd", "yyyy-MM-dd'T'HH:mm:ss",
                                              "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mm:ss.SSSZ", "yyyy-MM-dd'T'HH:mm"].map {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = $0
        return f
    }

    /// Parses ISO dates, Notion export dates ("May 4, 2024 3:15 PM") and ranges ("A → B").
    public static func parse(_ raw: String) -> DateValue? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        for sep in [" → ", " -> "] where s.contains(sep) {
            let parts = s.components(separatedBy: sep)
            if parts.count == 2, let a = parse(parts[0]) {
                let b = parse(parts[1])
                return DateValue(start: a.start, end: b?.start, includeTime: a.includeTime)
            }
        }
        if let d = isoDay.date(from: s) { return DateValue(start: d) }
        if let d = isoMinute.date(from: s) { return DateValue(start: d, includeTime: true) }
        for f in notionLong {
            if let d = f.date(from: s) {
                let hasTime = f.dateFormat.contains("H") || f.dateFormat.contains("h")
                return DateValue(start: d, includeTime: hasTime)
            }
        }
        return nil
    }

    public static func format(_ d: DateValue) -> String {
        let f = d.includeTime ? isoMinute : isoDay
        var s = f.string(from: d.start)
        if let e = d.end { s += " → " + f.string(from: e) }
        return s
    }
}