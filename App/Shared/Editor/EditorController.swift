import SwiftUI
import Observation
import BasedCore
#if os(macOS)
import AppKit
#endif

/// What a text view exposes to the editor.
@MainActor
protocol TextHost: AnyObject {
    var hostBlockID: RecordID { get }
    func focus(at offset: Int?)
    func selectedRange() -> NSRange
    func reload(selection: NSRange?)
    func endEditing()
    func setTypingMarks(_ marks: Marks)
    func currentTypingMarks() -> Marks
    /// Re-reports the selection (selection-driven UI follows scrolling).
    func reportSelection()
}

final class WeakHost {
    weak var host: (any TextHost)?
    init(_ h: any TextHost) { host = h }
}

struct SelectionAnchor: Equatable {
    var blockID: RecordID
    var rect: CGRect
}

struct InlineMenu: Equatable {
    enum Kind: Equatable { case slash, mention, pageLink, emoji }
    var kind: Kind
    var blockID: RecordID
    /// UTF-16 offset of the trigger character(s).
    var anchor: Int
    var query: String
    var highlighted = 0
    var triggerLength: Int { kind == .pageLink ? 2 : 1 }
}

enum MenuItem: Identifiable, Hashable {
    case command(SlashCommand)
    case page(RecordID)
    case newPage(String)
    case date(DateValue, String)
    case person(String)
    case emoji(String, String)

    var id: String {
        switch self {
        case .command(let c): return "c:" + c.title
        case .page(let p): return "p:" + p
        case .newPage(let t): return "n:" + t
        case .date(_, let l): return "d:" + l
        case .person(let p): return "u:" + p
        case .emoji(let e, _): return "e:" + e
        }
    }
}

enum PickerPurpose: Identifiable {
    case linkToPage(after: RecordID)
    case linkedView(after: RecordID)
    case move([RecordID])
    var id: String {
        switch self {
        case .linkToPage(let a): return "l" + a
        case .linkedView(let a): return "v" + a
        case .move(let ids): return "m" + ids.joined()
        }
    }
}

struct EditResult {
    var text: RichText
    var selection: NSRange
}

/// Keyboard and structure logic for one page; text views forward events here.
@MainActor @Observable
final class EditorController {
    let pageID: RecordID
    let model: AppModel
    var focusedID: RecordID?
    var selectedBlocks: Set<RecordID> = []
    var menu: InlineMenu? {
        didSet {
            if oldValue == nil, menu != nil { menuOpenedAt = Date() }
            #if DEBUG
            if oldValue != nil, menu == nil {
                Log.notice("menu closed: " + Thread.callStackSymbols.dropFirst(1).prefix(6).map { String($0.split(separator: " ", omittingEmptySubsequences: true).dropFirst(3).prefix(1).joined()) }.joined(separator: " ← "), category: "debug")
            }
            #endif
        }
    }
    /// When the "/" / "@" menu opened. Focusing a new line (gutter +, ⌘/ …) briefly reports the caret at 0 —
    /// before the trigger — which used to close the menu again right away ("sometimes the menu doesn't stay").
    @ObservationIgnored private var menuOpenedAt = Date.distantPast
    var hasTextSelection = false
    var picker: PickerPurpose?
    var linkEditor: RecordID?
    /// Page typography (font, small text, full width); mirrored from the page block.
    var format: PageFormat?
    var isLocked: Bool { format?.locked == true }
    /// + / ⋮⋮ gutter and block dragging (see `BlockGutter.swift`).
    let gutter = BlockGutterState()
    @ObservationIgnored private var hosts: [RecordID: WeakHost] = [:]
    @ObservationIgnored var pendingFocus: FocusTarget?

    init(pageID: RecordID, model: AppModel) {
        self.pageID = pageID
        self.model = model
    }

    var store: WorkspaceStore { model.store }

    // MARK: Hosts & focus

    func register(_ host: any TextHost) {
        hosts[host.hostBlockID] = WeakHost(host)
        if let f = pendingFocus, f.id == host.hostBlockID {
            pendingFocus = nil
            DispatchQueue.main.async { host.focus(at: f.offset) }
        }
    }

    func unregister(_ host: any TextHost) {
        if hosts[host.hostBlockID]?.host === host { hosts[host.hostBlockID] = nil }
    }

    func host(_ id: RecordID) -> (any TextHost)? { hosts[id]?.host }

    #if os(macOS)
    /// Drag-selection across paragraphs (see `BasedNSTextView.mouseDown`): selects every block between
    /// `from` and the paragraph nearest to the pointer, in page order.
    func selectBlockRange(from: RecordID, toWindowPoint p: CGPoint, in window: NSWindow) {
        var best: (id: RecordID, distance: CGFloat)?
        for (id, weak) in hosts {
            guard let c = weak.host as? TextCoordinator, let v = c.view, v.window === window else { continue }
            let f = v.convert(v.bounds, to: nil)
            let d = p.y < f.minY ? f.minY - p.y : p.y > f.maxY ? p.y - f.maxY : 0
            if best == nil || d < best!.distance { best = (id, d) }
        }
        guard let target = best?.id else { return }
        let order = store.visibleOrder(in: pageID)
        guard let a = order.firstIndex(of: from), let b = order.firstIndex(of: target) else { selectedBlocks = [from]; return }
        let range = order[min(a, b)...max(a, b)]
        // Children of a selected block go with it; keep the selection to the outermost blocks.
        let set = Set(range)
        selectedBlocks = Set(range.filter { id in !set.contains { $0 != id && store.isDescendant(id, of: $0) } })
    }
    #endif

    func focus(_ target: FocusTarget?) {
        guard let target else { return }
        selectedBlocks = []
        if let h = host(target.id) {
            DispatchQueue.main.async { h.focus(at: target.offset) }
        } else {
            pendingFocus = target
            // Long pages render lazily: bring the block on screen so its text view exists and takes focus.
            scrollRequest = target.id
        }
    }

    /// Rubber-band selection rectangle while dragging on the page (canvas coordinates).
    var marquee: CGRect?

    /// Selected text (macOS): where the formatting toolbar floats, in window coordinates.
    var selectionRect: SelectionAnchor?

    /// The empty line where the inline "Ask AI to write…" box is open (space on an empty line).
    var aiPrompt: RecordID?

    /// A block to scroll into view (the page observes it; long pages only render what's visible).
    var scrollRequest: RecordID?

    func focusEnd(_ id: RecordID) {
        focus(FocusTarget(id, store.blocks[id]?.text.length ?? 0))
    }

    func didBeginEditing(_ id: RecordID) {
        focusedID = id
        selectedBlocks = []
        if let m = menu, m.blockID != id { menu = nil }
        model.activeEditor = self
    }

    func didEndEditing(_ id: RecordID) {
        if focusedID == id { focusedID = nil; hasTextSelection = false }
        if selectionRect?.blockID == id, linkEditor == nil { selectionRect = nil }
    }

    func selectionChanged(_ id: RecordID, _ r: NSRange) {
        hasTextSelection = r.length > 0
        if let m = menu, m.blockID == id, r.location <= m.anchor, Date().timeIntervalSince(menuOpenedAt) > 0.35 { menu = nil }
    }

    /// Click below the last block: focus the last text block or add one.
    func focusEndOfPage() {
        let order = store.visibleOrder(in: pageID)
        if let last = order.last, let b = store.blocks[last], b.type.isTextEditable, b.text.isEmpty, b.type == .text {
            focus(FocusTarget(last, 0)); return
        }
        let id = store.insertBlock(.text, in: .block(pageID))
        focus(FocusTarget(id, 0))
    }

    // MARK: Text changes

    func textDidChange(_ id: RecordID, _ text: RichText, selection: NSRange, inserted: Bool) -> EditResult? {
        gutter.hideWhileTyping()
        guard let b = store.blocks[id] else { return nil }
        let caret = selection.location
        if b.type == .page {
            store.setText(id, RichText(text.plainText.replacingOccurrences(of: "\n", with: " ")))
            return nil
        }
        // Notion: space on an empty line asks AI to write here.
        if inserted, b.type == .text, text.plainText == " ", menu == nil {
            store.setText(id, RichText())
            aiPrompt = id
            return EditResult(text: RichText(), selection: NSRange(location: 0, length: 0))
        }
        if inserted, b.type != .code {
            if b.type == .text, caret == text.length,
               let sc = MarkdownShortcuts.immediateShortcut(text: text.plainText, currentType: b.type) {
                store.transact("Turn into \(sc.type.displayName)") { tx in
                    tx.update(id) { $0.type = sc.type; $0.text = RichText(); if sc.type == .code { $0.props.language = "plain text" } }
                }
                if sc.type == .divider {
                    let next = store.insertBlock(.text, after: id) ?? id
                    focus(FocusTarget(next, 0))
                } else {
                    focus(FocusTarget(id, 0))
                }
                return EditResult(text: RichText(), selection: NSRange(location: 0, length: 0))
            }
            let plain = text.plainText as NSString
            if caret > 0, caret <= plain.length, plain.substring(with: NSRange(location: caret - 1, length: 1)) == " " {
                let before = plain.substring(to: caret)
                if let sc = MarkdownShortcuts.blockShortcut(before: before, currentType: b.type) {
                    let rest = text.slice(sc.consumed, text.length)
                    store.transact("Turn into \(sc.type.displayName)") { tx in
                        tx.update(id) { blk in
                            blk.type = sc.type
                            blk.text = rest
                            if sc.type == .todo { blk.props.checked = sc.checked ?? false }
                            if sc.type == .toggle { blk.props.isOpen = blk.props.isOpen ?? false }
                            if let t = sc.toggleable { blk.props.toggleable = t; blk.props.isOpen = true }
                        }
                    }
                    return EditResult(text: rest, selection: NSRange(location: 0, length: 0))
                }
            }
            if let r = InlineMarkdown.apply(text, caret: caret) {
                store.setText(id, r.text)
                host(id)?.setTypingMarks(.plain)
                return EditResult(text: r.text, selection: NSRange(location: r.caret, length: 0))
            }
        }
        store.setText(id, b.type == .code ? RichText(text.plainText) : text)
        updateMenu(id, text.plainText, caret: caret, inserted: inserted)
        return nil
    }

    private func updateMenu(_ id: RecordID, _ plain: String, caret: Int, inserted: Bool) {
        let ns = plain as NSString
        if var m = menu, m.blockID == id {
            let start = m.anchor + m.triggerLength
            guard caret >= start, start <= ns.length else { menu = nil; return }
            let q = ns.substring(with: NSRange(location: start, length: caret - start))
            if q.contains("\n") || q.count > 40 || q.hasPrefix(" ") || q.hasSuffix("   ") { menu = nil; return }
            m.query = q
            m.highlighted = 0
            menu = m
            if m.kind == .slash, q.count > 2, menuItems().isEmpty, q.hasSuffix(" ") { menu = nil }
            return
        }
        guard inserted, let b = store.blocks[id], b.type != .code, let trig = InlineTrigger.detect(plain, caret: caret) else { return }
        switch trig {
        case .slash: menu = InlineMenu(kind: .slash, blockID: id, anchor: caret - 1, query: "")
        case .mention: menu = InlineMenu(kind: .mention, blockID: id, anchor: caret - 1, query: "")
        case .pageLink: menu = InlineMenu(kind: .pageLink, blockID: id, anchor: caret - 2, query: "")
        case .emoji: menu = InlineMenu(kind: .emoji, blockID: id, anchor: caret - 1, query: "")
        case .newPage: break
        }
    }

    func menuItems() -> [MenuItem] {
        guard let m = menu else { return [] }
        let q = m.query.trimmingCharacters(in: .whitespaces)
        switch m.kind {
        case .slash:
            return SlashCommands.search(q).prefix(40).map(MenuItem.command)
        case .emoji:
            guard q.count >= 1 else { return [] }
            return EmojiCatalog.search(q, limit: 30).map { MenuItem.emoji($0.0, $0.1) }
        case .mention, .pageLink:
            var items: [MenuItem] = []
            if m.kind == .mention {
                let cal = Calendar.current
                let today = cal.startOfDay(for: Date())
                let dates: [(String, Date)] = [("Today", today), ("Tomorrow", cal.date(byAdding: .day, value: 1, to: today)!),
                                               ("Yesterday", cal.date(byAdding: .day, value: -1, to: today)!)]
                for (label, d) in dates where q.isEmpty || label.lowercased().hasPrefix(q.lowercased()) {
                    items.append(.date(DateValue(start: d), label))
                }
                if q.lowercased() == "now" { items.append(.date(DateValue(start: Date(), includeTime: true), "Now")) }
                if let parsed = DateParsing.parse(q) { items.append(.date(parsed, DateDisplay.long(parsed))) }
                if q.isEmpty || "me".hasPrefix(q.lowercased()) { items.append(.person("me")) }
            }
            let hits = SearchEngine(store: store).search(q, filters: { var f = SearchFilters(); f.titleOnly = true; return f }(), limit: 8)
            items += hits.map { MenuItem.page($0.pageID) }
            if !q.isEmpty { items.append(.newPage(q)) }
            return items
        }
    }

    func moveHighlight(_ delta: Int) {
        guard var m = menu else { return }
        let n = menuItems().count
        guard n > 0 else { return }
        m.highlighted = (m.highlighted + delta + n) % n
        menu = m
    }

    func chooseHighlighted() {
        guard let m = menu else { return }
        let items = menuItems()
        guard m.highlighted < items.count else { menu = nil; return }
        choose(items[m.highlighted])
    }

    /// Replace the trigger + query with the chosen item.
    func choose(_ item: MenuItem) {
        guard let m = menu, let b = store.blocks[m.blockID] else { return }
        menu = nil
        let id = m.blockID
        let end = min(b.text.length, m.anchor + m.triggerLength + (m.query as NSString).length)
        let start = min(m.anchor, end)
        func insert(_ rt: RichText) {
            let t = b.text.replacing(start, end, with: rt)
            store.updateBlock(id, name: "Insert") { $0.text = t }
            host(id)?.reload(selection: NSRange(location: start + rt.length, length: 0))
            focus(FocusTarget(id, start + rt.length))
        }
        switch item {
        case .command(let cmd):
            let t = b.text.replacing(start, end, with: RichText())
            store.updateBlock(id, name: "Edit") { $0.text = t }
            host(id)?.reload(selection: NSRange(location: start, length: 0))
            run(cmd, in: id, caret: start)
        case .page(let pid):
            insert(RichText(runs: [TextRun(store.title(of: pid), mention: .page(pid)), TextRun(" ")]))
        case .newPage(let title):
            let pid = store.createPage(title: RichText(title), in: .block(pageID), at: .end)
            insert(RichText(runs: [TextRun(title, mention: .page(pid)), TextRun(" ")]))
        case .date(let d, let label):
            insert(RichText(runs: [TextRun("@" + label, mention: .date(d)), TextRun(" ")]))
        case .person(let p):
            insert(RichText(runs: [TextRun("@Me", mention: .user(p)), TextRun(" ")]))
        case .emoji(let e, _):
            insert(RichText(e))
        }
    }

    // MARK: Slash commands

    func run(_ cmd: SlashCommand, in id: RecordID, caret: Int) {
        guard let b = store.blocks[id] else { return }
        let empty = b.text.isEmpty
        let replaceable = empty && (b.type == .text || b.type.isHeading || b.type.isList || b.type == .quote)
        let parent = b.parent
        switch cmd.action {
        case .block(let t):
            if t.isTextEditable {
                if replaceable || empty {
                    store.turnInto([id], t)
                    if t == .toggle { store.updateBlock(id) { $0.props.isOpen = true } }
                    focus(FocusTarget(id, 0))
                } else if let n = store.insertBlock(t, after: id) {
                    focus(FocusTarget(n, 0))
                }
                return
            }
            var props = BlockProps()
            switch t {
            case .table: props.tableColumns = 3; props.tableHeaderRow = false
            case .callout: props.icon = .emoji("💡")
            case .button: props.buttonLabel = "New button"
            case .equation: props.expression = ""
            default: break
            }
            let target: RecordID
            if replaceable {
                store.transact("Turn into \(t.displayName)") { tx in tx.update(id) { $0.type = t; $0.props = props; $0.text = RichText() } }
                target = id
            } else {
                target = store.insertBlock(t, props: props, in: parent, at: .after(id))
            }
            if t == .table {
                store.transact("Table rows", undoable: false) { tx in
                    let keys = FractionalIndex.keys(count: 2, between: nil, nil)
                    for k in keys {
                        var rp = BlockProps(); rp.cells = [RichText(), RichText(), RichText()]
                        tx.put(Block(type: .tableRow, parent: .block(target), sortKey: k, props: rp))
                    }
                }
            }
            if t == .syncedBlock {
                let inner = store.insertBlock(.text, in: .block(target))
                focus(FocusTarget(inner, 0))
            } else if t == .divider || t == .tableOfContents || t == .breadcrumb {
                let next = store.insertBlock(.text, in: parent, at: .after(target))
                focus(FocusTarget(next, 0))
            } else {
                host(id)?.endEditing()
                selectedBlocks = [target]
            }
        case .codeBlock(let language):
            var target = id
            if replaceable || empty { store.turnInto([id], .code) }
            else if let n = store.insertBlock(.code, after: id) { target = n }
            // Starts in Code mode; the block header switches to Preview (and remembers it per block).
            store.updateBlock(target, name: "Code language") { $0.props.language = language; $0.props.url = nil }
            focus(FocusTarget(target, 0))
        case .toggleHeading(let h):
            if replaceable || empty {
                store.turnInto([id], h, toggleable: true)
                store.updateBlock(id) { $0.props.isOpen = true }
                focus(FocusTarget(id, 0))
            } else {
                var p = BlockProps(); p.toggleable = true; p.isOpen = true
                let n = store.insertBlock(h, props: p, in: parent, at: .after(id))
                focus(FocusTarget(n, 0))
            }
        case .page:
            let pid = store.createPage(in: parent, at: .after(id))
            if replaceable { store.deleteBlocks([id]) }
            model.open(pid)
        case .columns(let n):
            store.transact("Columns") { tx in
                let list = Block(type: .columnList, parent: parent, sortKey: tx.sortKey(in: parent, .after(id)))
                tx.put(list)
                let keys = FractionalIndex.keys(count: n, between: nil, nil)
                for k in keys {
                    let col = Block(type: .column, parent: .block(list.id), sortKey: k)
                    tx.put(col)
                    tx.put(Block(type: .text, parent: .block(col.id), sortKey: FractionalIndex.between(nil, nil)))
                }
                if replaceable { tx.removeBlock(id) }
            }
        case .database(let inline, let view):
            let c = store.createDatabase(in: parent, at: .after(id), inline: inline, viewType: view)
            if replaceable { store.deleteBlocks([id]) }
            if !inline { model.open(c.blockID) } else { host(id)?.endEditing() }
        case .linkedView:
            picker = .linkedView(after: id)
        case .linkToPage:
            picker = .linkToPage(after: id)
        case .mentionPage:
            insertTrigger(id, caret: caret, "@", kind: .mention)
        case .mentionPerson:
            insertTrigger(id, caret: caret, "@", kind: .mention, query: "")
        case .date:
            let t = b.text.replacing(caret, caret, with: RichText(runs: [TextRun("@Today", mention: .date(DateValue(start: Calendar.current.startOfDay(for: Date())))), TextRun(" ")]))
            store.updateBlock(id, name: "Insert date") { $0.text = t }
            host(id)?.reload(selection: NSRange(location: t.length, length: 0))
        case .emoji:
            insertTrigger(id, caret: caret, ":", kind: .emoji)
        case .inlineEquation:
            let t = b.text.replacing(caret, caret, with: RichText(runs: [TextRun("x^2", equation: "x^2")]))
            store.updateBlock(id, name: "Insert equation") { $0.text = t }
            host(id)?.reload(selection: NSRange(location: caret + 3, length: 0))
        case .color(let c):
            store.setColor([id], c)
            focus(FocusTarget(id, caret))
        case .delete:
            let order = store.visibleOrder(in: pageID)
            let prev = order.firstIndex(of: id).flatMap { $0 > 0 ? order[$0 - 1] : nil }
            store.deleteBlocks([id])
            if let prev { focusEnd(prev) }
        case .duplicate:
            if let n = store.duplicateBlocks([id]).first { focus(FocusTarget(n, 0)) }
        case .moveTo:
            picker = .move([id])
        case .turnIntoPage:
            store.turnInto([id], .page)
            model.open(id)
        }
    }

    private func insertTrigger(_ id: RecordID, caret: Int, _ trigger: String, kind: InlineMenu.Kind, query: String = "") {
        guard let b = store.blocks[id] else { return }
        let t = b.text.replacing(caret, caret, with: RichText(trigger))
        store.updateBlock(id, name: "Edit") { $0.text = t }
        host(id)?.reload(selection: NSRange(location: caret + 1, length: 0))
        menu = InlineMenu(kind: kind, blockID: id, anchor: caret, query: query)
        focus(FocusTarget(id, caret + 1))
    }

    // MARK: Keys

    /// Return. Returns true when handled (the text view must not insert a newline).
    func handleReturn(_ id: RecordID, selection: NSRange, shift: Bool) -> Bool {
        if menu != nil, menu?.blockID == id { chooseHighlighted(); return true }
        guard let b = store.blocks[id] else { return false }
        if shift && b.type != .page { return false }
        if b.type == .code { return false }
        if b.type == .page {
            // Title → first block
            if let first = store.contentBlocks(of: id).first, first.type.isTextEditable, selection.location >= b.text.length {
                focus(FocusTarget(first.id, 0))
            } else {
                let (head, tail) = b.text.split(at: selection.location)
                store.transact("New block") { tx in
                    tx.update(id) { $0.text = head }
                    let nb = Block(type: .text, parent: .block(id), sortKey: tx.sortKey(in: .block(id), .start), text: tail)
                    tx.put(nb)
                    DispatchQueue.main.async { [weak self] in self?.focus(FocusTarget(nb.id, 0)) }
                }
            }
            return true
        }
        var offset = selection.location
        if selection.length > 0 {
            let t = b.text.replacing(selection.location, selection.location + selection.length, with: RichText())
            store.updateBlock(id, name: "Delete") { $0.text = t }
            offset = selection.location
        }
        store.breakUndoCoalescing()
        let target = store.splitBlock(id, at: offset)
        if target?.id == id { host(id)?.reload(selection: NSRange(location: 0, length: 0)) }
        focus(target)
        return true
    }

    func handleBackspaceAtStart(_ id: RecordID) -> Bool {
        guard let b = store.blocks[id], b.type != .page else { return false }
        store.breakUndoCoalescing()
        if let t = store.mergeIntoPrevious(id, pageID: pageID) {
            if t.id == id { host(id)?.reload(selection: NSRange(location: 0, length: 0)) }
            focus(t)
        } else if store.visibleOrder(in: pageID).first == id, b.text.isEmpty, b.type == .text {
            // first empty block: go to the title
            store.deleteBlocks([id])
            focusEnd(pageID)
        }
        return true
    }

    func handleDeleteAtEnd(_ id: RecordID) -> Bool {
        guard let b = store.blocks[id], b.type != .page, b.type != .code else { return false }
        if let t = store.mergeNext(id, pageID: pageID) {
            host(id)?.reload(selection: NSRange(location: t.offset, length: 0))
            return true
        }
        return false
    }

    func handleTab(_ id: RecordID, shift: Bool) -> Bool {
        if menu?.blockID == id { chooseHighlighted(); return true }
        guard let b = store.blocks[id], b.type != .page else { return false }
        if b.type == .code { return false }
        let caret = host(id)?.selectedRange().location ?? 0
        if shift { store.outdent([id]) } else { store.indent([id]) }
        focus(FocusTarget(id, caret))
        return true
    }

    /// Up/down at the first/last line moves to the neighbouring block.
    func handleVertical(_ id: RecordID, up: Bool) -> Bool {
        if menu?.blockID == id { moveHighlight(up ? -1 : 1); return true }
        var order = store.visibleOrder(in: pageID).filter { store.blocks[$0]?.type.isTextEditable == true }
        order.insert(pageID, at: 0)
        guard let i = order.firstIndex(of: id) else { return false }
        let j = up ? i - 1 : i + 1
        guard j >= 0, j < order.count else { return false }
        let target = order[j]
        focus(FocusTarget(target, up ? (store.blocks[target]?.text.length ?? 0) : 0))
        return true
    }

    func handleHorizontalBoundary(_ id: RecordID, left: Bool) -> Bool {
        var order = store.visibleOrder(in: pageID).filter { store.blocks[$0]?.type.isTextEditable == true }
        order.insert(pageID, at: 0)
        guard let i = order.firstIndex(of: id) else { return false }
        let j = left ? i - 1 : i + 1
        guard j >= 0, j < order.count else { return false }
        focus(FocusTarget(order[j], left ? (store.blocks[order[j]]?.text.length ?? 0) : 0))
        return true
    }

    func handleEscape(_ id: RecordID) -> Bool {
        if menu != nil { menu = nil; return true }
        guard id != pageID else { return false }
        host(id)?.endEditing()
        selectedBlocks = [id]
        return true
    }

    // MARK: Formatting

    func toggleMark(_ kind: MarkKind) {
        if !selectedBlocks.isEmpty {
            let ids = Array(selectedBlocks)
            let all = ids.allSatisfy { id in store.blocks[id].map { $0.text.isEmpty || $0.text.all(0, $0.text.length) { kind.get($0) } } ?? true }
            store.updateBlocks(ids, name: "Format") { b in
                b.text = b.text.applying(0, b.text.length) { kind.set(&$0, !all) }
            }
            return
        }
        guard let id = focusedID, let h = host(id), let b = store.blocks[id], b.type.hasRichText else { return }
        let r = h.selectedRange()
        if r.length == 0 {
            var m = h.currentTypingMarks()
            kind.set(&m, !kind.get(m))
            h.setTypingMarks(m)
            return
        }
        let t = b.text.toggling(kind, r.location, r.location + r.length)
        store.updateBlock(id, name: "Format") { $0.text = t }
        h.reload(selection: r)
    }

    func setTextColor(_ color: TColor?) {
        guard let id = focusedID, let h = host(id), let b = store.blocks[id] else {
            if !selectedBlocks.isEmpty { store.setColor(Array(selectedBlocks), color) }
            return
        }
        let r = h.selectedRange()
        if r.length == 0 { store.setColor([id], color); return }
        let t = b.text.settingColor(color == .default ? nil : color, r.location, r.location + r.length)
        store.updateBlock(id, name: "Color") { $0.text = t }
        h.reload(selection: r)
    }

    func setLink(_ url: String?) {
        guard let id = focusedID ?? linkEditor, let h = host(id), let b = store.blocks[id] else { return }
        let r = h.selectedRange()
        guard r.length > 0 else { return }
        var link = url?.trimmingCharacters(in: .whitespaces)
        if let l = link, !l.isEmpty, !l.contains("://"), !l.hasPrefix("mailto:") { link = "https://" + l }
        let t = b.text.settingLink((link?.isEmpty ?? true) ? nil : link, r.location, r.location + r.length)
        store.updateBlock(id, name: "Link") { $0.text = t }
        h.reload(selection: r)
    }

    func currentLink() -> String? {
        guard let id = focusedID, let h = host(id), let b = store.blocks[id] else { return nil }
        let r = h.selectedRange()
        return b.text.marks(at: r.location).link
    }

    // MARK: Paste

    /// Multi-line paste becomes blocks (Markdown aware). Returns true when handled.
    func paste(_ string: String, into id: RecordID, selection: NSRange) -> Bool {
        guard let b = store.blocks[id], b.type != .code, b.type != .page else { return false }
        let normalized = string.replacingOccurrences(of: "\r\n", with: "\n")
        let trimmed = normalized.trimmingCharacters(in: .newlines)
        guard trimmed.contains("\n") || MarkdownImporter.heading(trimmed) != nil || trimmed.hasPrefix("- ") else {
            if let url = URL(string: trimmed), url.scheme?.hasPrefix("http") == true, selection.length > 0 {
                setLink(trimmed); return true
            }
            return false
        }
        var items = MarkdownImporter(resolveLink: { _ in nil }).parse(trimmed)
        guard !items.isEmpty else { return false }
        let (head, tail) = b.text.split(at: selection.location)
        let tailEnd = b.text.slice(min(b.text.length, selection.location + selection.length), b.text.length)
        _ = tail
        var focusID = id
        store.transact("Paste") { tx in
            // first pasted line merges into the current block when it is plain text
            if items[0].type == .text, items[0].children.isEmpty {
                let first = items.removeFirst()
                tx.update(id) { $0.text = head + first.text }
            } else {
                tx.update(id) { $0.text = head }
            }
            let keys = tx.sortKeys(items.count, in: b.parent, .after(id))
            var last = id
            for (item, k) in zip(items, keys) { last = store.putImported(item, parent: b.parent, sortKey: k, tx: tx) }
            if !tailEnd.isEmpty {
                if let lb = tx.block(last), lb.type.isTextEditable { tx.update(last) { $0.text = $0.text + tailEnd } }
                else {
                    let nb = Block(type: .text, parent: b.parent, sortKey: tx.sortKey(in: b.parent, .after(last)), text: tailEnd)
                    tx.put(nb); last = nb.id
                }
            }
            focusID = last
        }
        host(id)?.reload(selection: nil)
        let len = store.blocks[focusID]?.text.length ?? 0
        focus(FocusTarget(focusID, max(0, len - tailEnd.length)))
        return true
    }

    // MARK: Block selection

    func deleteSelection() {
        let ids = Array(selectedBlocks)
        guard !ids.isEmpty else { return }
        let order = store.visibleOrder(in: pageID)
        let firstIdx = ids.compactMap { order.firstIndex(of: $0) }.min()
        store.deleteBlocks(ids)
        selectedBlocks = []
        if let i = firstIdx, i > 0 { focusEnd(order[i - 1]) }
    }

    func duplicateSelection() {
        let ids = store.duplicateBlocks(Array(selectedBlocks))
        selectedBlocks = Set(ids)
    }

    func copySelectionAsMarkdown() -> String {
        let blocks = store.documentOrder(Array(selectedBlocks)).compactMap { store.blocks[$0] }
        return MarkdownExporter(store: store).exportBlocks(blocks, indent: 0)
    }
}