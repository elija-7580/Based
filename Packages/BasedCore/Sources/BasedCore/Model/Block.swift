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
    /// Meeting notes: recording, transcript, notes and AI summary (see Meeting.swift).
    case meeting
    /// Notes or summary area inside a meeting.
    case meetingSection
    /// A chunk of a meeting's transcript (`props.segments`).
    case transcript
    /// A block type from a newer Based version (BSD-25). Shown read-only; the original type string is kept
    /// in `Block.extra["type"]` and written back on encode.
    case unknown = "__unknown"

    public var displayName: String {
        switch self {
        case .unknown: return "Unsupported block"
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
        case .meeting: return "Meeting notes"
        case .meetingSection: return "Meeting section"
        case .transcript: return "Transcript"
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
             .page, .column, .columnList, .table, .syncedBlock, .meeting, .meetingSection,
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

/// One step of a Notion button ("When button is clicked → Do: …"). A button runs its steps in order.
public struct ButtonAction: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        /// Insert the button's child blocks below it.
        case insertBlocks
        /// Add a page to a database (`targetID`), with a name (`title`) and property values (`values`).
        case addPage
        /// Open a page (`targetID`) in `mode`.
        case openPage
        /// Open a page added by an earlier step (`step`: index of that step; nil = the last page added).
        case openAdded
        /// Open a web link (`url`).
        case openURL
        /// Ask before going on (`message`); Cancel stops the remaining steps.
        case confirm

        public var displayName: String {
            switch self {
            case .insertBlocks: return "Insert blocks"
            case .addPage: return "Add page to"
            case .openPage: return "Open page"
            case .openAdded: return "Open added page"
            case .openURL: return "Open link"
            case .confirm: return "Show confirmation"
            }
        }
        public var symbol: String {
            switch self {
            case .insertBlocks: return "plus.square.on.square"
            case .addPage: return "plus"
            case .openPage, .openAdded: return "arrow.up.right"
            case .openURL: return "link"
            case .confirm: return "checkmark.circle"
            }
        }
    }
    public var kind: Kind
    /// Database for `addPage`, page for `openPage`.
    public var targetID: RecordID?
    /// Legacy single-action buttons: open the added page afterwards (default true). Steps use `openAdded`.
    public var openAfter: Bool?
    /// `addPage`: property values for the new page (property id → value), like Notion's "Add page to … with".
    public var values: [String: PropertyValue]?
    /// `addPage`: name of the new page.
    public var title: String?
    /// `openPage` / `openAdded`: where to open (nil = the app's default).
    public var mode: OpenMode?
    /// `openAdded`: index of the `addPage` step whose page opens (nil = the last page added).
    public var step: Int?
    /// `openURL`: the link.
    public var url: String?
    /// `confirm`: the question.
    public var message: String?

    public init(kind: Kind, targetID: RecordID? = nil, openAfter: Bool? = nil, values: [String: PropertyValue]? = nil,
                title: String? = nil, mode: OpenMode? = nil, step: Int? = nil, url: String? = nil, message: String? = nil) {
        self.kind = kind; self.targetID = targetID; self.openAfter = openAfter; self.values = values
        self.title = title; self.mode = mode; self.step = step; self.url = url; self.message = message
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
    /// Simple table: column widths in points (missing = default), column background colours.
    public var tableColumnWidths: [Double]?
    public var tableColumnColors: [TColor?]?
    /// Table row: background colour per cell (the row's own colour is `color`).
    public var cellColors: [TColor?]?
    public var databaseID: RecordID?
    public var viewIDs: [RecordID]?
    public var linkTarget: RecordID?
    public var syncSource: RecordID?
    public var format: PageFormat?
    public var bookmark: BookmarkMeta?
    public var width: Double?
    public var isTemplate: Bool?
    public var buttonLabel: String?
    /// What a button block does when clicked (nil = insert its child blocks, the original behaviour).
    /// Superseded by `buttonActions`; still read for buttons made before steps existed.
    public var buttonAction: ButtonAction?
    /// A button's steps, run in order ("When button is clicked → Do: …"). See `effectiveButtonActions`.
    public var buttonActions: [ButtonAction]?
    /// Top-level pages only: the teamspace whose sidebar section lists the page (nil = Private).
    public var teamspace: RecordID?
    /// `.meeting`: recording state, tracks, speakers, context.
    public var meeting: MeetingInfo?
    /// `.meetingSection`: notes or summary.
    public var meetingSection: MeetingSectionKind?
    /// `.transcript`: the segments of this chunk.
    public var segments: [TranscriptSegment]?
    /// Blocks typed into meeting notes while recording: seconds into the recording (click → play from there).
    public var meetingTime: Double?
    /// Props written by a newer version that this one doesn't know (BSD-25); written back unchanged.
    public var extra: [String: JSONValue] = [:]

    public init() {}
}

/// Every piece of content is a block; pages and database rows too.
/// Reference storage for `Block.props` (see there). Value semantics: equality and hashing by value, and
/// `Block` only mutates it in place when it holds the only reference.
final class PropsStorage: Hashable, @unchecked Sendable {
    var value: BlockProps
    init(_ v: BlockProps) { value = v }
    static let empty = PropsStorage(BlockProps())
    static func make(_ v: BlockProps) -> PropsStorage { v == BlockProps() ? empty : PropsStorage(v) }
    static func == (a: PropsStorage, b: PropsStorage) -> Bool { a === b || a.value == b.value }
    func hash(into h: inout Hasher) { h.combine(value) }
}

public struct Block: Codable, Hashable, Identifiable, Sendable {
    public var id: RecordID
    public var type: BlockType
    public var parent: ParentRef
    public var sortKey: String
    public var text: RichText
    /// Block properties (icon, cover, colour, checked, caption …). Stored copy-on-write behind a reference:
    /// `BlockProps` is ~500 bytes and empty for most blocks, so every empty block shares one instance
    /// (71k-block workspace: −35 MB). Reading and writing `props` works exactly like a stored property.
    public var props: BlockProps {
        get { _props.value }
        set {
            if newValue == BlockProps() { _props = PropsStorage.empty }
            else if isKnownUniquelyReferenced(&_props), _props !== PropsStorage.empty { _props.value = newValue }
            else { _props = PropsStorage(newValue) }
        }
    }
    private var _props: PropsStorage
    /// Database row values keyed by property id.
    public var values: [String: PropertyValue]
    public var createdAt: Date
    public var updatedAt: Date
    public var createdBy: String?
    public var updatedBy: String?
    /// Non-nil when the page (and everything inside it) is in the trash.
    public var trashedAt: Date?
    public var stamp: Stamp
    /// Top-level fields written by a newer version that this one doesn't know (BSD-25); written back unchanged.
    /// Holds the original type string under "type" when `type == .unknown`.
    public var extra: [String: JSONValue] = [:]

    public init(id: RecordID = RecordIDs.make(), type: BlockType, parent: ParentRef, sortKey: String,
                text: RichText = RichText(), props: BlockProps = BlockProps(), values: [String: PropertyValue] = [:],
                createdAt: Date = Date(), createdBy: String? = nil) {
        self.id = id; self.type = type; self.parent = parent; self.sortKey = sortKey
        self.text = text; self._props = PropsStorage.make(props); self.values = values
        self.createdAt = createdAt; self.updatedAt = createdAt
        self.createdBy = createdBy; self.updatedBy = createdBy
        self.trashedAt = nil; self.stamp = .zero
    }

    enum CodingKeys: String, CodingKey {
        case id, type, parent, sortKey = "sk", text, props, values, createdAt, updatedAt, createdBy, updatedBy, trashedAt, stamp
    }
    static let knownKeys: Set<String> = ["id", "type", "parent", "sk", "text", "props", "values", "createdAt", "updatedAt",
                                         "createdBy", "updatedBy", "trashedAt", "stamp"]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(RecordID.self, forKey: .id)
        let rawType = try c.decode(String.self, forKey: .type)
        type = BlockType(rawValue: rawType) ?? .unknown
        parent = try c.decode(ParentRef.self, forKey: .parent)
        sortKey = try c.decode(String.self, forKey: .sortKey)
        text = try c.decodeIfPresent(RichText.self, forKey: .text) ?? RichText()
        _props = PropsStorage.make(try c.decodeIfPresent(BlockProps.self, forKey: .props) ?? BlockProps())
        values = try c.decodeIfPresent([String: PropertyValue].self, forKey: .values) ?? [:]
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
        updatedBy = try c.decodeIfPresent(String.self, forKey: .updatedBy)
        trashedAt = try c.decodeIfPresent(Date.self, forKey: .trashedAt)
        stamp = try c.decodeIfPresent(Stamp.self, forKey: .stamp) ?? .zero
        extra = try UnknownKeys.decode(from: decoder, known: Self.knownKeys)
        if type == .unknown { extra[CodingKeys.type.rawValue] = .string(rawType) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        if type != .unknown { try c.encode(type, forKey: .type) }
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
        // An unknown block type that was changed to a known one drops the stale original.
        try UnknownKeys.encode(type == .unknown ? extra : extra.filter { $0.key != CodingKeys.type.rawValue }, to: encoder)
    }

    public var title: String { text.plainText }
    public var isRow: Bool { if case .database = parent { return true } else { return false } }
}
