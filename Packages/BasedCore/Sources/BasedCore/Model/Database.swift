import Foundation

public enum PropertyType: String, Codable, CaseIterable, Sendable {
    case title, text, number, select, multiSelect, status, date, person, files, checkbox
    case url, email, phone, formula, relation, rollup
    case createdTime, createdBy, lastEditedTime, lastEditedBy, button, uniqueID, place, verification

    public var displayName: String {
        switch self {
        case .title: return "Title"
        case .text: return "Text"
        case .number: return "Number"
        case .select: return "Select"
        case .multiSelect: return "Multi-select"
        case .status: return "Status"
        case .date: return "Date"
        case .person: return "Person"
        case .files: return "Files & media"
        case .checkbox: return "Checkbox"
        case .url: return "URL"
        case .email: return "Email"
        case .phone: return "Phone"
        case .formula: return "Formula"
        case .relation: return "Relation"
        case .rollup: return "Rollup"
        case .createdTime: return "Created time"
        case .createdBy: return "Created by"
        case .lastEditedTime: return "Last edited time"
        case .lastEditedBy: return "Last edited by"
        case .button: return "Button"
        case .uniqueID: return "ID"
        case .place: return "Place"
        case .verification: return "Verification"
        }
    }

    /// Values are computed, not stored on the row.
    public var isComputed: Bool {
        [.formula, .rollup, .createdTime, .createdBy, .lastEditedTime, .lastEditedBy, .button, .uniqueID].contains(self)
    }

    public static let creatable: [PropertyType] = [.text, .number, .select, .multiSelect, .status, .date, .person, .files,
                                                    .checkbox, .url, .email, .phone, .formula, .relation, .rollup,
                                                    .createdTime, .createdBy, .lastEditedTime, .lastEditedBy, .uniqueID, .place]
}

public struct SelectOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var color: TColor

    public init(id: String = RecordIDs.make(), name: String, color: TColor = .default) {
        self.id = id; self.name = name; self.color = color
    }
}

public struct StatusGroup: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var color: TColor
    public var optionIDs: [String]

    public init(id: String = RecordIDs.make(), name: String, color: TColor, optionIDs: [String]) {
        self.id = id; self.name = name; self.color = color; self.optionIDs = optionIDs
    }
}

public enum NumberFormat: String, Codable, CaseIterable, Sendable {
    case number, numberWithCommas, percent, dollar, euro, pound, yen, franc, rupee, won, yuan, real, ruble, lira

    public var displayName: String {
        switch self {
        case .number: return "Number"
        case .numberWithCommas: return "Number with commas"
        case .percent: return "Percent"
        case .dollar: return "US dollar"
        case .euro: return "Euro"
        case .pound: return "Pound"
        case .yen: return "Yen"
        case .franc: return "Swiss franc"
        case .rupee: return "Rupee"
        case .won: return "Won"
        case .yuan: return "Yuan"
        case .real: return "Real"
        case .ruble: return "Ruble"
        case .lira: return "Lira"
        }
    }
}

public struct RelationConfig: Codable, Hashable, Sendable {
    public var databaseID: RecordID
    public var syncedPropertyID: String?
    public var limitOne: Bool?

    public init(databaseID: RecordID, syncedPropertyID: String? = nil, limitOne: Bool? = nil) {
        self.databaseID = databaseID; self.syncedPropertyID = syncedPropertyID; self.limitOne = limitOne
    }
}

public enum CalculationType: String, Codable, CaseIterable, Sendable {
    case none, countAll, countValues, countUnique, countEmpty, countNotEmpty, percentEmpty, percentNotEmpty
    case sum, average, median, min, max, range, earliest, latest, dateRange
    case checked, unchecked, percentChecked, percentUnchecked
    case showOriginal

    public var displayName: String {
        switch self {
        case .none: return "None"
        case .countAll: return "Count all"
        case .countValues: return "Count values"
        case .countUnique: return "Count unique values"
        case .countEmpty: return "Count empty"
        case .countNotEmpty: return "Count not empty"
        case .percentEmpty: return "Percent empty"
        case .percentNotEmpty: return "Percent not empty"
        case .sum: return "Sum"
        case .average: return "Average"
        case .median: return "Median"
        case .min: return "Min"
        case .max: return "Max"
        case .range: return "Range"
        case .earliest: return "Earliest date"
        case .latest: return "Latest date"
        case .dateRange: return "Date range"
        case .checked: return "Checked"
        case .unchecked: return "Unchecked"
        case .percentChecked: return "Percent checked"
        case .percentUnchecked: return "Percent unchecked"
        case .showOriginal: return "Show original"
        }
    }
}

public struct RollupConfig: Codable, Hashable, Sendable {
    public var relationPropertyID: String
    public var targetPropertyID: String
    public var function: CalculationType

    public init(relationPropertyID: String, targetPropertyID: String, function: CalculationType = .showOriginal) {
        self.relationPropertyID = relationPropertyID; self.targetPropertyID = targetPropertyID; self.function = function
    }
}

public struct PropertySchema: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var type: PropertyType
    public var options: [SelectOption]?
    public var statusGroups: [StatusGroup]?
    public var numberFormat: NumberFormat?
    public var formula: String?
    public var relation: RelationConfig?
    public var rollup: RollupConfig?
    public var idPrefix: String?
    public var dateFormat: String?
    public var description: String?

    public init(id: String = RecordIDs.make(), name: String, type: PropertyType) {
        self.id = id; self.name = name; self.type = type
        if type == .status { self.applyDefaultStatus() }
        if type == .select || type == .multiSelect { options = [] }
    }

    public mutating func applyDefaultStatus() {
        let notStarted = SelectOption(name: "Not started", color: .default)
        let inProgress = SelectOption(name: "In progress", color: .blue)
        let done = SelectOption(name: "Done", color: .green)
        options = [notStarted, inProgress, done]
        statusGroups = [
            StatusGroup(name: "To-do", color: .gray, optionIDs: [notStarted.id]),
            StatusGroup(name: "In progress", color: .blue, optionIDs: [inProgress.id]),
            StatusGroup(name: "Complete", color: .green, optionIDs: [done.id]),
        ]
    }

    public func option(_ id: String) -> SelectOption? { options?.first { $0.id == id } }
    public func option(named name: String) -> SelectOption? {
        options?.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }
}

public struct FileValue: Codable, Hashable, Sendable {
    public var name: String
    public var asset: AssetRef?
    public var url: String?

    public init(name: String, asset: AssetRef? = nil, url: String? = nil) {
        self.name = name; self.asset = asset; self.url = url
    }
}

/// A stored value of a database row property.
public enum PropertyValue: Codable, Hashable, Sendable {
    case text(RichText)
    case number(Double)
    case select(String)
    case multiSelect([String])
    case status(String)
    case date(DateValue)
    case person([String])
    case files([FileValue])
    case checkbox(Bool)
    case url(String)
    case email(String)
    case phone(String)
    case relation([RecordID])
    case uniqueID(Int)
    case place(String)
}

/// Database (Notion calls the schema-holder a data source).
public struct Database: Codable, Hashable, Identifiable, Sendable {
    public var id: RecordID
    /// The block that owns this database (databaseInline or databasePage).
    public var blockID: RecordID
    public var title: RichText
    public var summary: RichText?
    public var properties: [PropertySchema]
    public var templateIDs: [RecordID]?
    public var defaultTemplateID: RecordID?
    public var nextUniqueID: Int?
    public var locked: Bool?
    public var createdAt: Date
    public var updatedAt: Date
    public var stamp: Stamp

    public init(id: RecordID = RecordIDs.make(), blockID: RecordID, title: RichText, properties: [PropertySchema]) {
        self.id = id; self.blockID = blockID; self.title = title; self.properties = properties
        self.createdAt = Date(); self.updatedAt = createdAt; self.stamp = .zero
    }

    public static let titlePropertyID = "title"

    public func property(_ id: String) -> PropertySchema? { properties.first { $0.id == id } }
    public func property(named name: String) -> PropertySchema? {
        properties.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }
    public var titleProperty: PropertySchema {
        properties.first { $0.type == .title } ?? PropertySchema(id: Database.titlePropertyID, name: "Name", type: .title)
    }
}

// MARK: - Views

public enum ViewType: String, Codable, CaseIterable, Sendable {
    case table, board, list, gallery, calendar, timeline, chart, feed, map, form

    public var displayName: String { rawValue.capitalized }

    /// View types implemented in this build.
    public static let available: [ViewType] = [.table, .board, .list, .gallery, .calendar, .timeline, .chart]
}

public enum Combinator: String, Codable, Sendable { case and, or }

public enum FilterOp: String, Codable, CaseIterable, Sendable {
    case equals, notEquals, contains, notContains, startsWith, endsWith, isEmpty, isNotEmpty
    case greater, less, greaterOrEqual, lessOrEqual
    case before, after, onOrBefore, onOrAfter, within

    public var displayName: String {
        switch self {
        case .equals: return "Is"
        case .notEquals: return "Is not"
        case .contains: return "Contains"
        case .notContains: return "Does not contain"
        case .startsWith: return "Starts with"
        case .endsWith: return "Ends with"
        case .isEmpty: return "Is empty"
        case .isNotEmpty: return "Is not empty"
        case .greater: return ">"
        case .less: return "<"
        case .greaterOrEqual: return "≥"
        case .lessOrEqual: return "≤"
        case .before: return "Is before"
        case .after: return "Is after"
        case .onOrBefore: return "Is on or before"
        case .onOrAfter: return "Is on or after"
        case .within: return "Is within"
        }
    }

    public var needsValue: Bool { self != .isEmpty && self != .isNotEmpty }

    public static func ops(for type: PropertyType) -> [FilterOp] {
        switch type {
        case .title, .text, .url, .email, .phone, .place, .formula, .rollup:
            return [.equals, .notEquals, .contains, .notContains, .startsWith, .endsWith, .isEmpty, .isNotEmpty]
        case .number, .uniqueID:
            return [.equals, .notEquals, .greater, .less, .greaterOrEqual, .lessOrEqual, .isEmpty, .isNotEmpty]
        case .select, .status:
            return [.equals, .notEquals, .isEmpty, .isNotEmpty]
        case .multiSelect, .person, .relation, .files:
            return [.contains, .notContains, .isEmpty, .isNotEmpty]
        case .date, .createdTime, .lastEditedTime:
            return [.equals, .before, .after, .onOrBefore, .onOrAfter, .within, .isEmpty, .isNotEmpty]
        case .checkbox:
            return [.equals, .notEquals]
        case .createdBy, .lastEditedBy, .button, .verification:
            return [.isEmpty, .isNotEmpty]
        }
    }
}

public enum RelativeDate: String, Codable, CaseIterable, Sendable {
    case today, tomorrow, yesterday, pastWeek, nextWeek, pastMonth, nextMonth, pastYear, nextYear
}

public enum FilterValue: Codable, Hashable, Sendable {
    case text(String)
    case number(Double)
    case bool(Bool)
    case date(Date)
    case relative(RelativeDate)
    case options([String])
}

public struct FilterCondition: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var propertyID: String
    public var op: FilterOp
    public var value: FilterValue?

    public init(id: String = RecordIDs.make(), propertyID: String, op: FilterOp, value: FilterValue? = nil) {
        self.id = id; self.propertyID = propertyID; self.op = op; self.value = value
    }
}

public indirect enum FilterItem: Codable, Hashable, Sendable {
    case condition(FilterCondition)
    case group(FilterGroup)
}

public struct FilterGroup: Codable, Hashable, Sendable {
    public var combinator: Combinator
    public var items: [FilterItem]

    public init(combinator: Combinator = .and, items: [FilterItem] = []) {
        self.combinator = combinator; self.items = items
    }

    public var isEmpty: Bool { items.isEmpty }
}

public struct SortRule: Codable, Hashable, Sendable, Identifiable {
    public var id: String { propertyID }
    public var propertyID: String
    public var ascending: Bool

    public init(propertyID: String, ascending: Bool = true) {
        self.propertyID = propertyID; self.ascending = ascending
    }
}

public enum DateGrouping: String, Codable, CaseIterable, Sendable { case relative, day, week, month, year }

public struct GroupRule: Codable, Hashable, Sendable {
    public var propertyID: String
    public var hiddenGroups: [String]?
    public var hideEmptyGroups: Bool?
    public var groupOrder: [String]?
    public var dateGrouping: DateGrouping?

    public init(propertyID: String) { self.propertyID = propertyID }
}

public struct ViewProperty: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var visible: Bool
    public var width: Double?

    public init(id: String, visible: Bool = true, width: Double? = nil) {
        self.id = id; self.visible = visible; self.width = width
    }
}

public enum CardCover: Codable, Hashable, Sendable {
    case none, pageCover, pageContent
    case property(String)
}

public enum CardSize: String, Codable, CaseIterable, Sendable { case small, medium, large }

public enum OpenMode: String, Codable, CaseIterable, Sendable {
    case sidePeek, centerPeek, fullPage

    public var displayName: String {
        switch self {
        case .sidePeek: return "Side peek"
        case .centerPeek: return "Center peek"
        case .fullPage: return "Full page"
        }
    }
}

public struct DatabaseView: Codable, Hashable, Identifiable, Sendable {
    public var id: RecordID
    public var databaseID: RecordID
    public var blockID: RecordID
    public var name: String
    public var type: ViewType
    public var filter: FilterGroup?
    public var sorts: [SortRule]?
    public var groupBy: GroupRule?
    public var properties: [ViewProperty]?
    public var calculations: [String: CalculationType]?
    public var datePropertyID: String?
    public var endDatePropertyID: String?
    public var cardCover: CardCover?
    public var cardSize: CardSize?
    public var wrapCells: Bool?
    public var openIn: OpenMode?
    public var showIcons: Bool?
    public var loadLimit: Int?
    public var chart: ChartConfig?
    public var sortKey: String
    public var createdAt: Date
    public var updatedAt: Date
    public var stamp: Stamp

    public init(id: RecordID = RecordIDs.make(), databaseID: RecordID, blockID: RecordID, name: String, type: ViewType, sortKey: String) {
        self.id = id; self.databaseID = databaseID; self.blockID = blockID; self.name = name; self.type = type
        self.sortKey = sortKey; self.createdAt = Date(); self.updatedAt = createdAt; self.stamp = .zero
    }

    /// Property ids in display order, honouring visibility.
    public func visiblePropertyIDs(in db: Database) -> [String] {
        let configured = properties ?? []
        var ids = configured.filter(\.visible).map(\.id).filter { db.property($0) != nil }
        let known = Set(configured.map(\.id))
        // properties added after the view was configured are visible by default in tables
        for p in db.properties where !known.contains(p.id) && (type == .table || p.type == .title) { ids.append(p.id) }
        let title = db.titleProperty.id
        if !ids.contains(title) { ids.insert(title, at: 0) }
        return ids
    }
}

// MARK: - Workspace

public struct Workspace: Codable, Hashable, Identifiable, Sendable {
    public var id: RecordID
    public var name: String
    public var icon: PageIcon?
    public var favorites: [RecordID]
    public var createdAt: Date
    public var updatedAt: Date
    public var stamp: Stamp

    public static let mainID = "workspace"

    public init(id: RecordID = Workspace.mainID, name: String = "My Workspace") {
        self.id = id; self.name = name; self.favorites = []
        self.createdAt = Date(); self.updatedAt = createdAt; self.stamp = .zero
    }
}

// MARK: - Record

/// Type-erased record used by persistence, undo and sync.
public enum Record: Hashable, Sendable {
    case block(Block)
    case database(Database)
    case view(DatabaseView)
    case workspace(Workspace)

    public var key: RecordKey {
        switch self {
        case .block(let b): return RecordKey(.block, b.id)
        case .database(let d): return RecordKey(.database, d.id)
        case .view(let v): return RecordKey(.view, v.id)
        case .workspace(let w): return RecordKey(.workspace, w.id)
        }
    }

    public var stamp: Stamp {
        switch self {
        case .block(let b): return b.stamp
        case .database(let d): return d.stamp
        case .view(let v): return v.stamp
        case .workspace(let w): return w.stamp
        }
    }

    static let encoder: JSONEncoder = JSONEncoder()
    static let decoder: JSONDecoder = JSONDecoder()

    public func encoded() throws -> Data {
        switch self {
        case .block(let b): return try Record.encoder.encode(b)
        case .database(let d): return try Record.encoder.encode(d)
        case .view(let v): return try Record.encoder.encode(v)
        case .workspace(let w): return try Record.encoder.encode(w)
        }
    }

    public static func decode(kind: RecordKind, data: Data) throws -> Record {
        switch kind {
        case .block: return .block(try decoder.decode(Block.self, from: data))
        case .database: return .database(try decoder.decode(Database.self, from: data))
        case .view: return .view(try decoder.decode(DatabaseView.self, from: data))
        case .workspace: return .workspace(try decoder.decode(Workspace.self, from: data))
        }
    }
}
