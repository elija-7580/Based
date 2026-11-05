import Foundation

public enum SlashSection: String, CaseIterable, Sendable {
    case basic = "Basic blocks"
    case media = "Media"
    case database = "Database"
    case advanced = "Advanced blocks"
    case inline = "Inline"
    case color = "Color"
    case action = "Actions"
}

public enum SlashAction: Hashable, Sendable {
    case block(BlockType)
    case toggleHeading(BlockType)
    case page
    case columns(Int)
    case database(inline: Bool, view: ViewType)
    case linkedView
    case linkToPage
    case mentionPage
    case mentionPerson
    case date
    case emoji
    case inlineEquation
    case color(TColor)
    case delete
    case duplicate
    case moveTo
    case turnIntoPage
}

public struct SlashCommand: Identifiable, Hashable, Sendable {
    public var id: String { title }
    public var title: String
    public var subtitle: String
    public var aliases: [String]
    public var section: SlashSection
    public var action: SlashAction
    public var symbol: String
    public var shortcut: String?

    public init(_ title: String, _ subtitle: String, _ section: SlashSection, _ action: SlashAction,
                symbol: String, aliases: [String] = [], shortcut: String? = nil) {
        self.title = title; self.subtitle = subtitle; self.section = section; self.action = action
        self.symbol = symbol; self.aliases = aliases; self.shortcut = shortcut
    }
}

public enum SlashCommands {
    public static let all: [SlashCommand] = {
        var c: [SlashCommand] = [
            .init("Text", "Just start writing with plain text.", .basic, .block(.text), symbol: "textformat", aliases: ["plain", "paragraph"]),
            .init("Page", "Embed a sub-page inside this page.", .basic, .page, symbol: "doc", aliases: ["subpage", "new page"]),
            .init("To-do list", "Track tasks with a to-do list.", .basic, .block(.todo), symbol: "checklist", aliases: ["todo", "checkbox", "task"], shortcut: "[]"),
            .init("Heading 1", "Big section heading.", .basic, .block(.heading1), symbol: "textformat.size.larger", aliases: ["h1", "title"], shortcut: "#"),
            .init("Heading 2", "Medium section heading.", .basic, .block(.heading2), symbol: "textformat.size", aliases: ["h2", "subtitle"], shortcut: "##"),
            .init("Heading 3", "Small section heading.", .basic, .block(.heading3), symbol: "textformat.size.smaller", aliases: ["h3"], shortcut: "###"),
            .init("Heading 4", "Smallest section heading.", .basic, .block(.heading4), symbol: "textformat.size.smaller", aliases: ["h4"], shortcut: "####"),
            .init("Table", "Add simple tabular content to your page.", .basic, .block(.table), symbol: "tablecells", aliases: ["simple table", "grid"]),
            .init("Bulleted list", "Create a simple bulleted list.", .basic, .block(.bulletedList), symbol: "list.bullet", aliases: ["bullet", "ul", "unordered"], shortcut: "-"),
            .init("Numbered list", "Create a list with numbering.", .basic, .block(.numberedList), symbol: "list.number", aliases: ["number", "ol", "ordered"], shortcut: "1."),
            .init("Toggle list", "Toggles can hide and show content inside.", .basic, .block(.toggle), symbol: "chevron.right", aliases: ["toggle", "collapse", "dropdown"], shortcut: ">"),
            .init("Quote", "Capture a quote.", .basic, .block(.quote), symbol: "text.quote", aliases: ["blockquote", "citation"], shortcut: "\""),
            .init("Divider", "Visually divide blocks.", .basic, .block(.divider), symbol: "minus", aliases: ["hr", "line", "separator"], shortcut: "---"),
            .init("Link to page", "Link to an existing page.", .basic, .linkToPage, symbol: "arrow.up.right.square", aliases: ["link"]),
            .init("Callout", "Make writing stand out.", .basic, .block(.callout), symbol: "lightbulb", aliases: ["note", "info", "warning", "tip"]),
            .init("Toggle heading 1", "Hide content inside a large heading.", .basic, .toggleHeading(.heading1), symbol: "chevron.right.2", aliases: ["toggle h1"]),
            .init("Toggle heading 2", "Hide content inside a medium heading.", .basic, .toggleHeading(.heading2), symbol: "chevron.right.2", aliases: ["toggle h2"]),
            .init("Toggle heading 3", "Hide content inside a small heading.", .basic, .toggleHeading(.heading3), symbol: "chevron.right.2", aliases: ["toggle h3"]),

            .init("Image", "Upload or embed with a link.", .media, .block(.image), symbol: "photo", aliases: ["picture", "photo", "img"]),
            .init("Video", "Upload or embed with a link.", .media, .block(.video), symbol: "play.rectangle", aliases: ["movie", "youtube"]),
            .init("Audio", "Upload or embed with a link.", .media, .block(.audio), symbol: "waveform", aliases: ["sound", "music", "mp3"]),
            .init("Code", "Capture a code snippet.", .media, .block(.code), symbol: "chevron.left.forwardslash.chevron.right", aliases: ["snippet", "pre"], shortcut: "```"),
            .init("File", "Upload or embed with a link.", .media, .block(.file), symbol: "paperclip", aliases: ["attachment", "upload"]),
            .init("PDF", "Embed a PDF document.", .media, .block(.pdf), symbol: "doc.richtext", aliases: ["document"]),
            .init("Web bookmark", "Save a link as a visual bookmark.", .media, .block(.bookmark), symbol: "bookmark", aliases: ["bookmark", "url", "link preview"]),
            .init("Embed", "Embed a web page.", .media, .block(.embed), symbol: "globe", aliases: ["iframe", "website"]),

            .init("Table view", "Add a table database.", .database, .database(inline: true, view: .table), symbol: "tablecells", aliases: ["database", "spreadsheet"]),
            .init("Board view", "Add a kanban board database.", .database, .database(inline: true, view: .board), symbol: "rectangle.split.3x1", aliases: ["kanban"]),
            .init("Gallery view", "Add a gallery database.", .database, .database(inline: true, view: .gallery), symbol: "square.grid.2x2", aliases: ["cards", "grid"]),
            .init("List view", "Add a list database.", .database, .database(inline: true, view: .list), symbol: "list.dash"),
            .init("Calendar view", "Add a calendar database.", .database, .database(inline: true, view: .calendar), symbol: "calendar"),
            .init("Timeline view", "Add a timeline database.", .database, .database(inline: true, view: .timeline), symbol: "chart.bar.xaxis", aliases: ["gantt", "roadmap"]),
            .init("Database - Inline", "Add an inline database to this page.", .database, .database(inline: true, view: .table), symbol: "cylinder.split.1x2"),
            .init("Database - Full page", "Add a database as a sub-page.", .database, .database(inline: false, view: .table), symbol: "cylinder"),
            .init("Linked view of database", "Show an existing database.", .database, .linkedView, symbol: "link", aliases: ["linked database"]),

            .init("Table of contents", "Show an outline of your page.", .advanced, .block(.tableOfContents), symbol: "list.bullet.indent", aliases: ["toc", "outline"]),
            .init("Block equation", "Display a standalone math equation.", .advanced, .block(.equation), symbol: "function", aliases: ["math", "latex", "tex"]),
            .init("Button", "Run actions with a click.", .advanced, .block(.button), symbol: "button.horizontal", aliases: ["template button"]),
            .init("Breadcrumb", "Show where this page lives.", .advanced, .block(.breadcrumb), symbol: "chevron.right.circle", aliases: ["path"]),
            .init("2 columns", "Create 2 columns of blocks.", .advanced, .columns(2), symbol: "rectangle.split.2x1", aliases: ["columns", "layout"]),
            .init("3 columns", "Create 3 columns of blocks.", .advanced, .columns(3), symbol: "rectangle.split.3x1", aliases: ["columns"]),
            .init("4 columns", "Create 4 columns of blocks.", .advanced, .columns(4), symbol: "rectangle.split.3x1", aliases: ["columns"]),
            .init("5 columns", "Create 5 columns of blocks.", .advanced, .columns(5), symbol: "rectangle.split.3x1", aliases: ["columns"]),
            .init("Synced block", "Sync content across pages.", .advanced, .block(.syncedBlock), symbol: "arrow.triangle.2.circlepath", aliases: ["sync", "transclusion"]),

            .init("Mention a person", "Ping someone so they get a notification.", .inline, .mentionPerson, symbol: "at", aliases: ["@", "user", "people"]),
            .init("Mention a page", "Link to a page inline.", .inline, .mentionPage, symbol: "doc.text", aliases: ["@", "link page"]),
            .init("Date or reminder", "Add a date or set a reminder.", .inline, .date, symbol: "calendar.badge.clock", aliases: ["today", "now", "remind", "@"]),
            .init("Emoji", "Search for an emoji to place in text.", .inline, .emoji, symbol: "face.smiling", aliases: ["emoticon", ":"]),
            .init("Inline equation", "Insert mathematical symbols in text.", .inline, .inlineEquation, symbol: "x.squareroot", aliases: ["math", "latex"]),

            .init("Delete", "Delete this block.", .action, .delete, symbol: "trash", aliases: ["remove", "del"]),
            .init("Duplicate", "Duplicate this block.", .action, .duplicate, symbol: "plus.square.on.square", aliases: ["copy"]),
            .init("Move to", "Move this block to another page.", .action, .moveTo, symbol: "arrow.turn.up.right", aliases: ["move"]),
            .init("Turn into page", "Turn this block into a page.", .action, .turnIntoPage, symbol: "doc.badge.arrow.up", aliases: ["page"]),
        ]
        for color in TColor.textColors {
            c.append(.init(color == .default ? "Default" : color.displayName, "Text color", .color, .color(color),
                           symbol: "textformat", aliases: [color.rawValue, "color"]))
        }
        for color in TColor.backgroundColors {
            c.append(.init(color.displayName + " background", "Background color", .color, .color(color),
                           symbol: "highlighter", aliases: ["background", "highlight"]))
        }
        return c
    }()

    /// Commands matching the text typed after "/". Empty query shows everything except colors/actions.
    public static func search(_ query: String) -> [SlashCommand] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return all.filter { $0.section != .color && $0.section != .action } }
        var scored: [(Int, Int, SlashCommand)] = []
        for (i, cmd) in all.enumerated() {
            if let s = score(cmd, q) { scored.append((s, i, cmd)) }
        }
        return scored.sorted { ($0.0, $0.1) < ($1.0, $1.1) }.map(\.2)
    }

    static func score(_ cmd: SlashCommand, _ q: String) -> Int? {
        let title = cmd.title.lowercased()
        if title == q { return 0 }
        if title.hasPrefix(q) { return 1 }
        if title.split(separator: " ").contains(where: { $0.hasPrefix(q) }) { return 2 }
        if cmd.aliases.contains(where: { $0.lowercased().hasPrefix(q) }) { return 3 }
        if title.contains(q) { return 4 }
        if let s = cmd.shortcut, s == q { return 3 }
        // subsequence ("bl" → "Bulleted list")
        var it = title.makeIterator()
        var matched = 0
        for ch in q { while let t = it.next() { if t == ch { matched += 1; break } } }
        if matched == q.count, q.count >= 3 { return 6 }
        return nil
    }
}

/// "Turn into" menu entries (subset of block types Notion allows converting between).
public enum TurnIntoOptions {
    public static let types: [BlockType] = [.text, .page, .todo, .heading1, .heading2, .heading3, .heading4,
                                            .bulletedList, .numberedList, .toggle, .code, .quote, .callout, .equation]
}