import Foundation

// BSD-25 / ADR 0002: records keep what this version doesn't understand.
//
// - Every record type (Block, BlockProps, Database, PropertySchema, DatabaseView, Workspace) collects the
//   top-level JSON keys it doesn't know into `extra` and writes them back unchanged on encode. An older
//   client that edits a record written by a newer one no longer drops the newer fields.
// - `BlockType`, `PropertyType` and `ViewType` decode an unknown value as `.unknown`; the original string
//   is kept in the owning record's `extra` under the same key ("type") and written back in its place.
// - The codable code below is written out by hand (synthesis can't carry `extra`). Every stored property
//   needs a CodingKey; `ForwardCompatibilityTests.everyStoredPropertyHasACodingKey` guards that.

/// A coding key for arbitrary JSON object keys.
struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

enum UnknownKeys {
    /// The keys of the object in `decoder` that aren't in `known`, with their raw JSON values.
    static func decode(from decoder: Decoder, known: Set<String>) throws -> [String: JSONValue] {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        var out: [String: JSONValue] = [:]
        for k in c.allKeys where !known.contains(k.stringValue) {
            out[k.stringValue] = try c.decode(JSONValue.self, forKey: k)
        }
        return out
    }

    /// Writes `extra` into the object `encoder` already holds (`extra` never repeats a key written there).
    static func encode(_ extra: [String: JSONValue], to encoder: Encoder) throws {
        guard !extra.isEmpty else { return }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        for (k, v) in extra.sorted(by: { $0.key < $1.key }) { try c.encode(v, forKey: AnyCodingKey(k)) }
    }
}

/// Enums stored as strings that must survive values from newer versions.
protocol OpenStringEnum: RawRepresentable where RawValue == String {
    static var unknown: Self { get }
}

extension OpenStringEnum {
    static func decodeOpen(from decoder: Decoder) throws -> Self {
        let s = try decoder.singleValueContainer().decode(String.self)
        return Self(rawValue: s) ?? .unknown
    }
}

extension BlockType: OpenStringEnum {
    public init(from decoder: Decoder) throws { self = try Self.decodeOpen(from: decoder) }
}
extension PropertyType: OpenStringEnum {
    public init(from decoder: Decoder) throws { self = try Self.decodeOpen(from: decoder) }
}
extension ViewType: OpenStringEnum {
    public init(from decoder: Decoder) throws { self = try Self.decodeOpen(from: decoder) }
}


extension BlockProps {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case checked, color, language, wrap, caption, url, asset, icon, cover, isOpen, toggleable, expression, ratio, tableColumns, tableHeaderRow, tableHeaderColumn, cells, tableColumnWidths, tableColumnColors, cellColors, databaseID, viewIDs, linkTarget, syncSource, format, bookmark, width, isTemplate, buttonLabel, buttonAction, buttonActions, teamspace, meeting, meetingSection, segments, meetingTime
    }
    static let knownKeys: Set<String> = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checked = try c.decodeIfPresent(Bool.self, forKey: .checked)
        color = try c.decodeIfPresent(TColor.self, forKey: .color)
        language = try c.decodeIfPresent(String.self, forKey: .language)
        wrap = try c.decodeIfPresent(Bool.self, forKey: .wrap)
        caption = try c.decodeIfPresent(RichText.self, forKey: .caption)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        asset = try c.decodeIfPresent(AssetRef.self, forKey: .asset)
        icon = try c.decodeIfPresent(PageIcon.self, forKey: .icon)
        cover = try c.decodeIfPresent(PageCover.self, forKey: .cover)
        isOpen = try c.decodeIfPresent(Bool.self, forKey: .isOpen)
        toggleable = try c.decodeIfPresent(Bool.self, forKey: .toggleable)
        expression = try c.decodeIfPresent(String.self, forKey: .expression)
        ratio = try c.decodeIfPresent(Double.self, forKey: .ratio)
        tableColumns = try c.decodeIfPresent(Int.self, forKey: .tableColumns)
        tableHeaderRow = try c.decodeIfPresent(Bool.self, forKey: .tableHeaderRow)
        tableHeaderColumn = try c.decodeIfPresent(Bool.self, forKey: .tableHeaderColumn)
        cells = try c.decodeIfPresent([RichText].self, forKey: .cells)
        tableColumnWidths = try c.decodeIfPresent([Double].self, forKey: .tableColumnWidths)
        tableColumnColors = try c.decodeIfPresent([TColor?].self, forKey: .tableColumnColors)
        cellColors = try c.decodeIfPresent([TColor?].self, forKey: .cellColors)
        databaseID = try c.decodeIfPresent(RecordID.self, forKey: .databaseID)
        viewIDs = try c.decodeIfPresent([RecordID].self, forKey: .viewIDs)
        linkTarget = try c.decodeIfPresent(RecordID.self, forKey: .linkTarget)
        syncSource = try c.decodeIfPresent(RecordID.self, forKey: .syncSource)
        format = try c.decodeIfPresent(PageFormat.self, forKey: .format)
        bookmark = try c.decodeIfPresent(BookmarkMeta.self, forKey: .bookmark)
        width = try c.decodeIfPresent(Double.self, forKey: .width)
        isTemplate = try c.decodeIfPresent(Bool.self, forKey: .isTemplate)
        buttonLabel = try c.decodeIfPresent(String.self, forKey: .buttonLabel)
        buttonAction = try c.decodeIfPresent(ButtonAction.self, forKey: .buttonAction)
        buttonActions = try c.decodeIfPresent([ButtonAction].self, forKey: .buttonActions)
        teamspace = try c.decodeIfPresent(RecordID.self, forKey: .teamspace)
        meeting = try c.decodeIfPresent(MeetingInfo.self, forKey: .meeting)
        meetingSection = try c.decodeIfPresent(MeetingSectionKind.self, forKey: .meetingSection)
        segments = try c.decodeIfPresent([TranscriptSegment].self, forKey: .segments)
        meetingTime = try c.decodeIfPresent(Double.self, forKey: .meetingTime)
        extra = try UnknownKeys.decode(from: decoder, known: Self.knownKeys)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(checked, forKey: .checked)
        try c.encodeIfPresent(color, forKey: .color)
        try c.encodeIfPresent(language, forKey: .language)
        try c.encodeIfPresent(wrap, forKey: .wrap)
        try c.encodeIfPresent(caption, forKey: .caption)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(asset, forKey: .asset)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encodeIfPresent(cover, forKey: .cover)
        try c.encodeIfPresent(isOpen, forKey: .isOpen)
        try c.encodeIfPresent(toggleable, forKey: .toggleable)
        try c.encodeIfPresent(expression, forKey: .expression)
        try c.encodeIfPresent(ratio, forKey: .ratio)
        try c.encodeIfPresent(tableColumns, forKey: .tableColumns)
        try c.encodeIfPresent(tableHeaderRow, forKey: .tableHeaderRow)
        try c.encodeIfPresent(tableHeaderColumn, forKey: .tableHeaderColumn)
        try c.encodeIfPresent(cells, forKey: .cells)
        try c.encodeIfPresent(tableColumnWidths, forKey: .tableColumnWidths)
        try c.encodeIfPresent(tableColumnColors, forKey: .tableColumnColors)
        try c.encodeIfPresent(cellColors, forKey: .cellColors)
        try c.encodeIfPresent(databaseID, forKey: .databaseID)
        try c.encodeIfPresent(viewIDs, forKey: .viewIDs)
        try c.encodeIfPresent(linkTarget, forKey: .linkTarget)
        try c.encodeIfPresent(syncSource, forKey: .syncSource)
        try c.encodeIfPresent(format, forKey: .format)
        try c.encodeIfPresent(bookmark, forKey: .bookmark)
        try c.encodeIfPresent(width, forKey: .width)
        try c.encodeIfPresent(isTemplate, forKey: .isTemplate)
        try c.encodeIfPresent(buttonLabel, forKey: .buttonLabel)
        try c.encodeIfPresent(buttonAction, forKey: .buttonAction)
        try c.encodeIfPresent(buttonActions, forKey: .buttonActions)
        try c.encodeIfPresent(teamspace, forKey: .teamspace)
        try c.encodeIfPresent(meeting, forKey: .meeting)
        try c.encodeIfPresent(meetingSection, forKey: .meetingSection)
        try c.encodeIfPresent(segments, forKey: .segments)
        try c.encodeIfPresent(meetingTime, forKey: .meetingTime)
        try UnknownKeys.encode(extra, to: encoder)
    }
}

extension PropertySchema {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name, type, options, statusGroups, numberFormat, formula, relation, rollup, idPrefix, dateFormat, description
    }
    static let knownKeys: Set<String> = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        let rawType = try c.decode(String.self, forKey: .type)
        type = PropertyType(rawValue: rawType) ?? .unknown
        options = try c.decodeIfPresent([SelectOption].self, forKey: .options)
        statusGroups = try c.decodeIfPresent([StatusGroup].self, forKey: .statusGroups)
        numberFormat = try c.decodeIfPresent(NumberFormat.self, forKey: .numberFormat)
        formula = try c.decodeIfPresent(String.self, forKey: .formula)
        relation = try c.decodeIfPresent(RelationConfig.self, forKey: .relation)
        rollup = try c.decodeIfPresent(RollupConfig.self, forKey: .rollup)
        idPrefix = try c.decodeIfPresent(String.self, forKey: .idPrefix)
        dateFormat = try c.decodeIfPresent(String.self, forKey: .dateFormat)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        extra = try UnknownKeys.decode(from: decoder, known: Self.knownKeys)
        if type == .unknown { extra[CodingKeys.type.rawValue] = .string(rawType) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        if type != .unknown { try c.encode(type, forKey: .type) }
        try c.encodeIfPresent(options, forKey: .options)
        try c.encodeIfPresent(statusGroups, forKey: .statusGroups)
        try c.encodeIfPresent(numberFormat, forKey: .numberFormat)
        try c.encodeIfPresent(formula, forKey: .formula)
        try c.encodeIfPresent(relation, forKey: .relation)
        try c.encodeIfPresent(rollup, forKey: .rollup)
        try c.encodeIfPresent(idPrefix, forKey: .idPrefix)
        try c.encodeIfPresent(dateFormat, forKey: .dateFormat)
        try c.encodeIfPresent(description, forKey: .description)
        try UnknownKeys.encode(extra, to: encoder)
    }
}

extension Database {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case id, blockID, title, summary, properties, templateIDs, defaultTemplateID, nextUniqueID, locked, createdAt, updatedAt, stamp
    }
    static let knownKeys: Set<String> = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(RecordID.self, forKey: .id)
        blockID = try c.decode(RecordID.self, forKey: .blockID)
        title = try c.decode(RichText.self, forKey: .title)
        summary = try c.decodeIfPresent(RichText.self, forKey: .summary)
        properties = try c.decode([PropertySchema].self, forKey: .properties)
        templateIDs = try c.decodeIfPresent([RecordID].self, forKey: .templateIDs)
        defaultTemplateID = try c.decodeIfPresent(RecordID.self, forKey: .defaultTemplateID)
        nextUniqueID = try c.decodeIfPresent(Int.self, forKey: .nextUniqueID)
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        stamp = try c.decode(Stamp.self, forKey: .stamp)
        extra = try UnknownKeys.decode(from: decoder, known: Self.knownKeys)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(blockID, forKey: .blockID)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(summary, forKey: .summary)
        try c.encode(properties, forKey: .properties)
        try c.encodeIfPresent(templateIDs, forKey: .templateIDs)
        try c.encodeIfPresent(defaultTemplateID, forKey: .defaultTemplateID)
        try c.encodeIfPresent(nextUniqueID, forKey: .nextUniqueID)
        try c.encodeIfPresent(locked, forKey: .locked)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(stamp, forKey: .stamp)
        try UnknownKeys.encode(extra, to: encoder)
    }
}

extension DatabaseView {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case id, databaseID, blockID, name, type, filter, sorts, groupBy, properties, calculations, datePropertyID, endDatePropertyID, cardCover, cardSize, wrapCells, openIn, showIcons, loadLimit, chart, mapPropertyID, mapHeight, dashboard, widgetOf, sortKey, createdAt, updatedAt, stamp
    }
    static let knownKeys: Set<String> = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(RecordID.self, forKey: .id)
        databaseID = try c.decode(RecordID.self, forKey: .databaseID)
        blockID = try c.decode(RecordID.self, forKey: .blockID)
        name = try c.decode(String.self, forKey: .name)
        let rawType = try c.decode(String.self, forKey: .type)
        type = ViewType(rawValue: rawType) ?? .unknown
        filter = try c.decodeIfPresent(FilterGroup.self, forKey: .filter)
        sorts = try c.decodeIfPresent([SortRule].self, forKey: .sorts)
        groupBy = try c.decodeIfPresent(GroupRule.self, forKey: .groupBy)
        properties = try c.decodeIfPresent([ViewProperty].self, forKey: .properties)
        calculations = try c.decodeIfPresent([String: CalculationType].self, forKey: .calculations)
        datePropertyID = try c.decodeIfPresent(String.self, forKey: .datePropertyID)
        endDatePropertyID = try c.decodeIfPresent(String.self, forKey: .endDatePropertyID)
        cardCover = try c.decodeIfPresent(CardCover.self, forKey: .cardCover)
        cardSize = try c.decodeIfPresent(CardSize.self, forKey: .cardSize)
        wrapCells = try c.decodeIfPresent(Bool.self, forKey: .wrapCells)
        openIn = try c.decodeIfPresent(OpenMode.self, forKey: .openIn)
        showIcons = try c.decodeIfPresent(Bool.self, forKey: .showIcons)
        loadLimit = try c.decodeIfPresent(Int.self, forKey: .loadLimit)
        chart = try c.decodeIfPresent(ChartConfig.self, forKey: .chart)
        mapPropertyID = try c.decodeIfPresent(String.self, forKey: .mapPropertyID)
        mapHeight = try c.decodeIfPresent(String.self, forKey: .mapHeight)
        dashboard = try c.decodeIfPresent(DashboardConfig.self, forKey: .dashboard)
        widgetOf = try c.decodeIfPresent(RecordID.self, forKey: .widgetOf)
        sortKey = try c.decode(String.self, forKey: .sortKey)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        stamp = try c.decode(Stamp.self, forKey: .stamp)
        extra = try UnknownKeys.decode(from: decoder, known: Self.knownKeys)
        if type == .unknown { extra[CodingKeys.type.rawValue] = .string(rawType) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(databaseID, forKey: .databaseID)
        try c.encode(blockID, forKey: .blockID)
        try c.encode(name, forKey: .name)
        if type != .unknown { try c.encode(type, forKey: .type) }
        try c.encodeIfPresent(filter, forKey: .filter)
        try c.encodeIfPresent(sorts, forKey: .sorts)
        try c.encodeIfPresent(groupBy, forKey: .groupBy)
        try c.encodeIfPresent(properties, forKey: .properties)
        try c.encodeIfPresent(calculations, forKey: .calculations)
        try c.encodeIfPresent(datePropertyID, forKey: .datePropertyID)
        try c.encodeIfPresent(endDatePropertyID, forKey: .endDatePropertyID)
        try c.encodeIfPresent(cardCover, forKey: .cardCover)
        try c.encodeIfPresent(cardSize, forKey: .cardSize)
        try c.encodeIfPresent(wrapCells, forKey: .wrapCells)
        try c.encodeIfPresent(openIn, forKey: .openIn)
        try c.encodeIfPresent(showIcons, forKey: .showIcons)
        try c.encodeIfPresent(loadLimit, forKey: .loadLimit)
        try c.encodeIfPresent(chart, forKey: .chart)
        try c.encodeIfPresent(mapPropertyID, forKey: .mapPropertyID)
        try c.encodeIfPresent(mapHeight, forKey: .mapHeight)
        try c.encodeIfPresent(dashboard, forKey: .dashboard)
        try c.encodeIfPresent(widgetOf, forKey: .widgetOf)
        try c.encode(sortKey, forKey: .sortKey)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(stamp, forKey: .stamp)
        try UnknownKeys.encode(extra, to: encoder)
    }
}

extension Workspace {
    enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name, icon, favorites, teamspaces, homePageID, createdAt, updatedAt, stamp
    }
    static let knownKeys: Set<String> = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(RecordID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        icon = try c.decodeIfPresent(PageIcon.self, forKey: .icon)
        favorites = try c.decode([RecordID].self, forKey: .favorites)
        teamspaces = try c.decodeIfPresent([Teamspace].self, forKey: .teamspaces)
        homePageID = try c.decodeIfPresent(RecordID.self, forKey: .homePageID)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        stamp = try c.decode(Stamp.self, forKey: .stamp)
        extra = try UnknownKeys.decode(from: decoder, known: Self.knownKeys)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encode(favorites, forKey: .favorites)
        try c.encodeIfPresent(teamspaces, forKey: .teamspaces)
        try c.encodeIfPresent(homePageID, forKey: .homePageID)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(stamp, forKey: .stamp)
        try UnknownKeys.encode(extra, to: encoder)
    }
}

