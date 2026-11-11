import SwiftUI
import BasedCore

/// Page menu → Version history, laid out like Notion's: the selected version as a read-only page on the
/// left (changed blocks marked in the margin), the versions grouped by day on the right, "Restore" below.
struct VersionHistorySheet: View {
    let pageID: RecordID
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var versions: [VersionHistory.Version] = []
    @State private var selected: VersionHistory.Version?
    @State private var blocks: [Block] = []
    @State private var confirmRestore = false
    static let changeColor = Color(Theme.dynamic(light: 0xCB912F, dark: 0xFFDC49))

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                Divider()
                preview
            }
            .frame(minWidth: 460, maxWidth: .infinity)
            Divider()
            sidebar.frame(width: 270)
        }
        .frame(minWidth: 820, idealWidth: 980, minHeight: 520, idealHeight: 680)
        .background(Color(Theme.pageBackgroundColor))
        .onAppear(perform: load)
        .onChange(of: selected) { _, v in blocks = v.map { model.pageHistory.blocks(of: $0) } ?? [] }
        .confirmationDialog("Restore this version?", isPresented: $confirmRestore) {
            Button("Restore") { restore() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The page goes back to how it was. The current state is kept as a version, and ⌘Z undoes the restore.")
        }
        .accessibilityIdentifier("versionHistory")
    }

    // MARK: Header / preview

    private var header: some View {
        HStack(spacing: 10) {
            Button(action: done) { Image(systemName: "xmark").font(DS.Text.small(.semibold)) }
                .buttonStyle(.quiet)
                .keyboardShortcut(.cancelAction)
                .help("Close (Esc)")
            if let v = selected {
                Text(v.date.formatted(date: .long, time: .shortened)).font(DS.Text.ui(.semibold))
                if v.id == versions.first?.id { Text("Latest").font(DS.Text.caption(.medium)).foregroundStyle(Theme.secondary) }
            } else {
                Text("Version history").font(DS.Text.ui(.semibold))
            }
            Spacer()
            let changed = changedCount
            if selected != nil, changed > 0 {
                HStack(spacing: 5) {
                    Circle().fill(Self.changeColor).frame(width: 6, height: 6)
                    Text("\(changed) block\(changed == 1 ? "" : "s") differ from now")
                }
                .font(DS.Text.small())
                .foregroundStyle(Theme.secondary)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
    }

    @ViewBuilder
    private var preview: some View {
        if selected == nil {
            ContentUnavailableView("No versions yet", systemImage: "clock.arrow.circlepath",
                                   description: Text("Versions are saved while you edit — every 10 minutes, after a pause, and when you open the page."))
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if let page = blocks.first {
                        HStack(spacing: 10) {
                            if page.props.icon != nil { PageIconView(icon: page.props.icon, size: 34) }
                            Text(page.text.plainText.isEmpty ? "Untitled" : page.text.plainText)
                                .font(.system(size: 32, weight: .bold))
                                .foregroundStyle(Theme.primary)
                        }
                        .padding(.bottom, 14)
                        ForEach(tree[page.id] ?? [], id: \.id) { b in VersionBlockView(block: b, tree: tree, depth: 0, changed: changedIDs) }
                    }
                }
                .padding(.horizontal, 56).padding(.vertical, 36)
                .frame(maxWidth: Theme.contentWidth + 112, alignment: .leading)
                .frame(maxWidth: .infinity)
                .textSelection(.enabled)
            }
        }
    }

    /// Children of each block in the version, in order (the version lists them in document order).
    private var tree: [RecordID: [Block]] {
        var t: [RecordID: [Block]] = [:]
        for b in blocks.dropFirst() {
            if case .block(let p) = b.parent { t[p, default: []].append(b) }
        }
        for k in t.keys { t[k]?.sort { $0.sortKey < $1.sortKey } }
        return t
    }

    /// Blocks whose content differs from the page as it is now (or that are gone now).
    private var changedIDs: Set<RecordID> {
        let store = model.store
        var out = Set<RecordID>()
        for b in blocks.dropFirst() {
            guard let cur = store.blocks[b.id], cur.trashedAt == nil else { out.insert(b.id); continue }
            if cur.text != b.text || cur.type != b.type || cur.props != b.props || cur.parent != b.parent || cur.values != b.values {
                out.insert(b.id)
            }
        }
        return out
    }

    private var changedCount: Int {
        let now = Set(model.store.versionBlocks(of: pageID).dropFirst().map(\.id))
        let then = Set(blocks.dropFirst().map(\.id))
        return changedIDs.count + now.subtracting(then).count
    }

    // MARK: Version list

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Version history").font(DS.Text.body(.semibold))
                Spacer()
            }
            .padding(.horizontal, 14).frame(height: 46)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1, pinnedViews: [.sectionHeaders]) {
                    ForEach(days, id: \.0) { day, items in
                        Section {
                            ForEach(items) { v in row(v) }
                        } header: {
                            Text(day).font(DS.Text.caption(.semibold)).foregroundStyle(Theme.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, DS.Space.xs)
                                .background(Color(Theme.pageBackgroundColor))
                        }
                    }
                }
                .padding(.horizontal, DS.Space.sm).padding(.bottom, DS.Space.md)
            }
            Divider()
            HStack {
                if let s = model.pageHistory.stats {
                    Text("\(s.versions) versions · \(ByteCountFormatter.string(fromByteCount: s.bytes, countStyle: .file))")
                        .font(DS.Text.caption()).foregroundStyle(Theme.secondary)
                        .help("All pages. Unchanged blocks are stored once and shared between versions.")
                }
                Spacer()
                Button("Restore") { confirmRestore = true }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected == nil || selected?.id == versions.first?.id && changedCount == 0)
                    .accessibilityIdentifier("versionHistory.restore")
            }
            .padding(DS.Space.lg)
        }
        .background(Color(Theme.pageBackgroundColor))
    }

    private func row(_ v: VersionHistory.Version) -> some View {
        let isSel = selected?.id == v.id
        let older = versions.firstIndex(of: v).flatMap { i in versions.indices.contains(i + 1) ? versions[i + 1] : nil }
        let delta = older.map { v.wordCount - $0.wordCount }
        return Button { selected = v } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(v.date.formatted(date: .omitted, time: .shortened)).font(DS.Text.ui(.medium)).foregroundStyle(Theme.primary)
                HStack(spacing: 6) {
                    Text("\(v.wordCount) words")
                    if let delta, delta != 0 {
                        Text(delta > 0 ? "+\(delta)" : "\(delta)")
                            .foregroundStyle(delta > 0 ? Color(Theme.dynamic(light: 0x448361, dark: 0x4DAB9A)) : Color(Theme.dynamic(light: 0xD44C47, dark: 0xDF5452)))
                    }
                    if v.reason == "before restore" { Text("· before restore") }
                    if v.reason == "restored" { Text("· restored") }
                }
                .font(DS.Text.small())
                .foregroundStyle(Theme.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .fill(isSel ? Theme.accentBlue.opacity(0.14) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.hoverFill(cornerRadius: DS.Radius.card, outset: 0))
    }

    private var days: [(String, [VersionHistory.Version])] {
        let cal = Calendar.current
        var out: [(String, [VersionHistory.Version])] = []
        for v in versions {
            let label: String
            if cal.isDateInToday(v.date) { label = "Today" }
            else if cal.isDateInYesterday(v.date) { label = "Yesterday" }
            else { label = v.date.formatted(date: .abbreviated, time: .omitted) }
            if out.last?.0 == label { out[out.count - 1].1.append(v) } else { out.append((label, [v])) }
        }
        return out
    }

    // MARK: Actions

    private func load() {
        versions = model.pageHistory.versions(of: pageID)
        // Notion opens on the version before the latest: the latest equals the page as it is.
        selected = versions.count > 1 ? versions[1] : versions.first
    }

    private func restore() {
        guard let v = selected else { return }
        model.pageHistory.restore(v)
        done()
    }
}

/// One block of a stored version, read-only, with its children. Blocks that differ from now get a mark in
/// the margin.
private struct VersionBlockView: View {
    let block: Block
    let tree: [RecordID: [Block]]
    let depth: Int
    let changed: Set<RecordID>

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            line
                .padding(.horizontal, block.props.color?.isBackground == true ? 6 : 0)
                .padding(.vertical, block.props.color?.isBackground == true ? 2 : 0)
                .background(RoundedRectangle(cornerRadius: DS.Radius.small).fill(background))
                .overlay(alignment: .leading) {
                    if changed.contains(block.id) {
                        Capsule().fill(VersionHistorySheet.changeColor)
                            .frame(width: 3).padding(.vertical, DS.Space.xxs).offset(x: -14 - CGFloat(depth) * 24)
                            .help("Different from the current page")
                    }
                }
            if let kids = tree[block.id], !kids.isEmpty, !block.type.isPageLike {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(kids, id: \.id) { VersionBlockView(block: $0, tree: tree, depth: depth + 1, changed: changed) }
                }
                .padding(.leading, DS.Space.xxl)
            }
        }
    }

    private var background: Color {
        if let c = block.props.color, c.isBackground { return Theme.color(c) }
        return .clear
    }

    private var foreground: Color {
        if let c = block.props.color, !c.isBackground { return Theme.color(c) }
        return Theme.primary
    }

    private var text: String { block.text.plainText }

    @ViewBuilder
    private var line: some View {
        switch block.type {
        case .heading1: Text(text).font(.system(size: 26, weight: .semibold)).foregroundStyle(foreground).padding(.top, 10)
        case .heading2: Text(text).font(.system(size: 21, weight: .semibold)).foregroundStyle(foreground).padding(.top, DS.Space.sm)
        case .heading3, .heading4: Text(text).font(.system(size: 18, weight: .semibold)).foregroundStyle(foreground).padding(.top, DS.Space.xs)
        case .bulletedList: marker("•") { body(text) }
        case .numberedList: marker("–") { body(text) }
        case .todo:
            marker(block.props.checked == true ? "☑" : "☐") {
                body(text).strikethrough(block.props.checked == true).opacity(block.props.checked == true ? 0.6 : 1)
            }
        case .toggle: marker("▾") { body(text) }
        case .quote:
            HStack(spacing: 10) { Rectangle().fill(Theme.primary).frame(width: 3); body(text) }
        case .callout:
            HStack(alignment: .top, spacing: 8) {
                PageIconView(icon: block.props.icon, size: 18)
                body(text)
            }
            .padding(DS.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: DS.Radius.control).fill(Theme.color(block.props.color.map { $0.isBackground ? $0 : $0.background } ?? .grayBackground)))
        case .divider: Rectangle().fill(Color(Theme.divider)).frame(height: 1).padding(.vertical, DS.Space.sm)
        case .code:
            Text(text).font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.primary)
                .padding(DS.Space.lg).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: DS.Radius.control).fill(Color(Theme.codeBackground)))
        case .page, .databasePage:
            HStack(spacing: 6) {
                PageIconView(icon: block.props.icon, isDatabase: block.type == .databasePage, size: 16)
                Text(text.isEmpty ? "Untitled" : text).underline().foregroundStyle(Theme.primary)
            }
            .font(.system(size: 15, weight: .medium))
        case .image, .video, .audio, .file, .pdf, .bookmark, .embed:
            placeholder(block.type.displayName, symbol: block.type.symbol)
        case .databaseInline: placeholder("Database", symbol: "tablecells")
        case .table: placeholder("Table", symbol: "tablecells")
        default:
            if text.isEmpty { Color.clear.frame(height: 18) } else { body(text) }
        }
    }

    private func body(_ s: String) -> Text {
        Text(s).font(.system(size: 15)).foregroundColor(foreground)
    }

    private func marker<C: View>(_ m: String, @ViewBuilder _ content: () -> C) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(m).font(.system(size: 15)).foregroundStyle(Theme.secondary).frame(width: 14)
            content()
        }
    }

    private func placeholder(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(DS.Text.body())
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, 10).frame(height: 32)
            .background(RoundedRectangle(cornerRadius: DS.Radius.control).fill(Theme.primary.opacity(DS.Fill.rest)))
    }
}
