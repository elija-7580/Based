import Foundation

public enum BlockType: String, Codable, CaseIterable, Sendable {
    case page
    case text
    case heading1, heading2, heading3, heading4
    case bulletedList, numberedList, todo, toggle
    case quote, callout, divider
    case code, equation
    case image, video, audio, file, pdf, bookmark, embed
    case tableOfContents, breadcrumb
    case columnList, column
    case table, tableRow
    case databaseInline, databasePage
    case linkToPage
    case syncedBlock
    case button

    public var displayName: String {
        switch self {
        case .page: return "Page"
        case .text: return "Text"
        case .heading1: return "Heading 1"
        case .heading2: return "Heading 2"
        case .heading3: return "Heading 3"
        case .heading4: return "Heading 4"
        case .bulletedList: return "Bulleted list"
        case .numberedList: return "Numbered list"
        case .todo: return "To-do list"
        case .toggle: return "Toggle list"
        case .quote: return "Quote"
        case .callout: return "Callout"
        case .divider: return "Divider"
        case .code: return "Code"
        case .equation: return "Block equation"
        case .image: return "Image"
        case .video: return "Video"
        case .audio: return "Audio"
        case .file: return "File"
        case .pdf: return "PDF"
        case .bookmark: return "Web bookmark"
        case .embed: return "Embed"
        case .tableOfContents: return "Table of contents"
        case .breadcrumb: return "Breadcrumb"
        case .columnList: return "Columns"
        case .column: return "Column"
        case .table: return "Table"
        case .tableRow: return "Table row"
        case .databaseInline: return "Database – Inline"
        case .databasePage: return "Database – Full page"
        case .linkToPage: return "Link to page"
        case .syncedBlock: return "Synced block"
        case .button: return "Button"
        }
    }

    /// Appears in the sidebar tree and opens as its own page.
    public var isPageLike: Bool { self == .page || self == .databasePage }

    public var isHeading: Bool { [.heading1, .heading2, .heading3, .heading4].contains(self) }

    /// Has an editable rich-text body in the editor.
    public var hasRichText: Bool {
        switch self {
        case .text, .heading1, .heading2, .heading3, .heading4, .bulletedList, .numberedList,
             .todo, .toggle, .quote, .callout:
            return true
        default:
            return false
        }
    }

    /// Edited as plain text (no inline marks).
    public var isPlainTextEditor: Bool { self == .code }

    public var isTextEditable: Bool { hasRichText || isPlainTextEditor }

    /// Can contain nested blocks in the editor.
    public var supportsChildren: Bool {
        switch self {
        case .text, .bulletedList, .numberedList, .todo, .toggle, .quote, .callout,
             .page, .column, .columnList, .table, .syncedBlock,
             .heading1, .heading2, .heading3, .heading4:
            return true
        default:
            return false
        }
    }

    /// Enter on a non-empty block creates a block of the same type.
    public var continuesOnEnter: Bool { [.bulletedList, .numberedList, .todo, .toggle].contains(self) }

    public var isList: Bool { [.bulletedList, .numberedList, .todo, .toggle].contains(self) }

    public var isMedia: Bool { [.image, .video, .audio, .file, .pdf, .bookmark, .embed].contains(self) }

    public var placeholder: String {
        switch self {
        case .text: return "Type '/' for commands"
        case .heading1: return "Heading 1"
        case .heading2: return "Heading 2"
        case .heading3: return "Heading 3"
        case .heading4: return "Heading 4"
        case .bulletedList, .numberedList: return "List"
        case .todo: return "To-do"
        case .toggle: return "Toggle"
        case .quote: return "Empty quote"
        case .callout: return "Type something…"
        case .code: return "Code"
        case .page: return "Untitled"
        default: return ""
        }
    }
}

/// Where a record lives.
public enum ParentRef: Hashable, Sendable, Codable, CustomStringConvertible {
    case workspace
    case block(RecordID)
    case database(RecordID)

    public var id: RecordID? {
        switch self {
        case .workspace: return nil
        case .block(let id), .database(let id): return id
        }
    }

    /// Index key for children lookups.
    public var key: String {
        switch self {
        case .workspace: return "w"
        case .block(let id): return "b:" + id
        case .database(let id): return "d:" + id
        }
    }

    public var description: String { key }

    public init?(key: String) {
        if key == "w" { self = .workspace; return }
        if key.hasPrefix("b:") { self = .block(String(key.dropFirst(2))); return }
        if key.hasPrefix("d:") { self = .database(String(key.dropFirst(2))); return }
        return nil
    }

    public init(from decoder: Decoder) throws {
        let s = try decoder.singleValueContainer().decode(String.self)
        guard let p = ParentRef(key: s) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad parent \(s)"))
        }
        self = p
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(key)
    }
}

/// A file stored in the local asset store (and synced as a CKAsset).
public struct AssetRef: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var size: Int?
    public var mime: String?

    public init(id: String, name: String, size: Int? = nil, mime: String? = nil) {
        self.id = id; self.name = name; self.size = size; self.mime = mime
    }
}

public enum PageIcon: Codable, Hashable, Sendable {
    case emoji(String)
    case asset(AssetRef)
    case url(String)
    case symbol(String)

    enum CodingKeys: String, CodingKey { case emoji, asset, url, symbol }

    public init(from decoder: Decoder) throws {
        if let s = try? decoder.singleValueContainer().decode(String.self) { self = .emoji(s); return }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let a = try c.decodeIfPresent(AssetRef.self, forKey: .asset) { self = .asset(a) }
        else if let u = try c.decodeIfPresent(String.self, forKey: .url) { self = .url(u) }
        else if let s = try c.decodeIfPresent(String.self, forKey: .symbol) { self = .symbol(s) }
        else { self = .emoji(try c.decodeIfPresent(String.self, forKey: .emoji) ?? "📄") }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .emoji(let e):
            var c = encoder.singleValueContainer(); try c.encode(e)
        case .asset(let a):
            var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(a, forKey: .asset)
        case .url(let u):
            var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(u, forKey: .url)
        case .symbol(let s):
            var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(s, forKey: .symbol)
        }
    }

    public var emoji: String? { if case .emoji(let e) = self { return e } else { return nil } }
}

public enum PageCover: Codable, Hashable, Sendable {
    case gradient(Int)
    case color(TColor)
    case asset(AssetRef)
    case url(String)
}

public enum PageFont: String, Codable, CaseIterable, Sendable {
    case `default`, serif, mono
}

public struct PageFormat: Codable, Hashable, Sendable {
    public var font: PageFont?
    public var smallText: Bool?
    public var fullWidth: Bool?
    public var locked: Bool?
    public var coverPosition: Double?
    public var hideBacklinks: Bool?
    /// Hide the floating outline (table of contents rail) on the right.
    public var hideOutline: Bool?

    public init(font: PageFont? = nil, smallText: Bool? = nil, fullWidth: Bool? = nil, locked: Bool? = nil) {
        self.font = font; self.smallText = smallText; self.fullWidth = fullWidth; self.locked = locked
    }
}

public struct BookmarkMeta: Codable, Hashable, Sendable {
    public var title: String?
    public var summary: String?
    public var imageURL: String?
    public var iconURL: String?

    public init(title: String? = nil, summary: String? = nil, imageURL: String? = nil, iconURL: String? = nil) {
        self.title = title; self.summary = summary; self.imageURL = imageURL; self.iconURL = iconURL
    }
}

/// Type-specific block data. All optional so the JSON stays compact.
public struct BlockProps: Codable, Hashable, Sendable {
    public var checked: Bool?
    public var color: TColor?
    public var language: String?
    public var wrap: Bool?
    public var caption: RichText?
    public var url: String?
    public var asset: AssetRef?
    public var icon: PageIcon?
    public var cover: PageCover?
    public var isOpen: Bool?
    public var toggleable: Bool?
    public var expression: String?
    public var ratio: Double?
    public var tableColumns: Int?
    public var tableHeaderRow: Bool?
    public var tableHeaderColumn: Bool?
    public var cells: [RichText]?
    public var databaseID: RecordID?
    public var viewIDs: [RecordID]?
    public var linkTarget: RecordID?
    public var syncSource: RecordID?
    public var format: PageFormat?
    public var bookmark: BookmarkMeta?
    public var width: Double?
    public var isTemplate: Bool?
    public var buttonLabel: String?

    public init() {}
}

/// Every piece of content is a block; pages and database rows too.
public struct Block: Codable, Hashable, Identifiable, Sendable {
    public var id: RecordID
    public var type: BlockType
    public var parent: ParentRef
    public var sortKey: String
    public var text: RichText
    public var props: BlockProps
    /// Database row values keyed by property id.
    public var values: [String: PropertyValue]
    public var createdAt: Date
    public var updatedAt: Date
    public var createdBy: String?
    public var updatedBy: String?
    /// Non-nil when the page (and everything inside it) is in the trash.
    public var trashedAt: Date?
    public var stamp: Stamp

    public init(id: RecordID = RecordIDs.make(), type: BlockType, parent: ParentRef, sortKey: String,
                text: RichText = RichText(), props: BlockProps = BlockProps(), values: [String: PropertyValue] = [:],
                createdAt: Date = Date(), createdBy: String? = nil) {
        self.id = id; self.type = type; self.parent = parent; self.sortKey = sortKey
        self.text = text; self.props = props; self.values = values
        self.createdAt = createdAt; self.updatedAt = createdAt
        self.createdBy = createdBy; self.updatedBy = createdBy
        self.trashedAt = nil; self.stamp = .zero
    }

    enum CodingKeys: String, CodingKey {
        case id, type, parent, sortKey = "sk", text, props, values, createdAt, updatedAt, createdBy, updatedBy, trashedAt, stamp
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(RecordID.self, forKey: .id)
        type = try c.decode(BlockType.self, forKey: .type)
        parent = try c.decode(ParentRef.self, forKey: .parent)
        sortKey = try c.decode(String.self, forKey: .sortKey)
        text = try c.decodeIfPresent(RichText.self, forKey: .text) ?? RichText()
        props = try c.decodeIfPresent(BlockProps.self, forKey: .props) ?? BlockProps()
        values = try c.decodeIfPresent([String: PropertyValue].self, forKey: .values) ?? [:]
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
        updatedBy = try c.decodeIfPresent(String.self, forKey: .updatedBy)
        trashedAt = try c.decodeIfPresent(Date.self, forKey: .trashedAt)
        stamp = try c.decodeIfPresent(Stamp.self, forKey: .stamp) ?? .zero
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(type, forKey: .type)
        try c.encode(parent, forKey: .parent)
        try c.encode(sortKey, forKey: .sortKey)
        if !text.isEmpty { try c.encode(text, forKey: .text) }
        if props != BlockProps() { try c.encode(props, forKey: .props) }
        if !values.isEmpty { try c.encode(values, forKey: .values) }
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encodeIfPresent(createdBy, forKey: .createdBy)
        try c.encodeIfPresent(updatedBy, forKey: .updatedBy)
        try c.encodeIfPresent(trashedAt, forKey: .trashedAt)
        try c.encode(stamp, forKey: .stamp)
    }

    public var title: String { text.plainText }
    public var isRow: Bool { if case .database = parent { return true } else { return false } }
}
