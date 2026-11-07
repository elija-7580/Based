import SwiftUI
import BasedCore

/// The page "•••" button and its panel, modelled on Notion: a quiet horizontal ellipsis that opens a
/// popover with a search field, three "Ag" font tiles, switches (small text, full width, lock …) and actions.
struct PageOptionsButton: View {
    let page: Block
    let editor: EditorController
    @State private var open = false
    @State private var hover = false

    var body: some View {
        Button { open.toggle() } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 6).fill(hover || open ? Chrome.hover : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Chrome.sidebarText)
        .onHover { hover = $0 }
        .help("Style, export and more…")
        .accessibilityIdentifier("page.menu")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            PageOptionsPanel(page: page, editor: editor) { open = false }
        }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .debugOpenPageMenu)) { _ in open = true }
        #endif
    }
}

#if DEBUG
extension Notification.Name { static let debugOpenPageMenu = Notification.Name("based.debug.openPageMenu") }
#endif

struct PageOptionsPanel: View {
    let page: Block
    let editor: EditorController
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private struct Action: Identifiable {
        let id: String
        let title: String
        let symbol: String
        var shortcut: String = ""
        var destructive = false
        let run: () -> Void
    }

    var body: some View {
        let store = model.store
        let f = page.props.format ?? PageFormat()
        VStack(alignment: .leading, spacing: 0) {
            // Search actions
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                TextField("Search actions…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .focused($searchFocused)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.hoverFill))
            .padding(10)

            if query.isEmpty {
                // Font tiles
                HStack(spacing: 6) {
                    FontTile(title: "Default", font: .default, current: f.font ?? .default) { set { $0.font = nil } }
                    FontTile(title: "Serif", font: .serif, current: f.font ?? .default) { set { $0.font = .serif } }
                    FontTile(title: "Mono", font: .mono, current: f.font ?? .default) { set { $0.font = .mono } }
                }
                .padding(.horizontal, 10).padding(.bottom, 8)
                Divider()
                VStack(spacing: 1) {
                    ToggleRow(title: "Small text", symbol: "textformat.size.smaller", on: f.smallText == true) { v in set { $0.smallText = v ? true : nil } }
                    ToggleRow(title: "Full width", symbol: "arrow.left.and.right", on: f.fullWidth == true) { v in set { $0.fullWidth = v ? true : nil } }
                    ToggleRow(title: "Outline", symbol: "list.bullet.indent", on: f.hideOutline != true) { v in set { $0.hideOutline = v ? nil : true } }
                    ToggleRow(title: "Backlinks", symbol: "arrow.uturn.left", on: f.hideBacklinks != true) { v in set { $0.hideBacklinks = v ? nil : true } }
                    ToggleRow(title: "Lock page", symbol: "lock", on: f.locked == true) { v in set { $0.locked = v ? true : nil } }
                }
                .padding(6)
                Divider()
            }
            ScrollView {
                VStack(spacing: 1) {
                    ForEach(filtered(actions(store))) { a in
                        PanelActionRow(title: a.title, symbol: a.symbol, shortcut: a.shortcut, destructive: a.destructive) {
                            done()
                            DispatchQueue.main.async { a.run() }
                        }
                    }
                }
                .padding(6)
            }
            .frame(maxHeight: query.isEmpty ? 260 : 380)
            Divider()
            VStack(alignment: .leading, spacing: 2) {
                Text("Word count: \(wordCount)")
                Text("Last edited \(page.updatedAt.formatted(date: .abbreviated, time: .shortened))")
            }
            .font(.system(size: 11.5))
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, 14).padding(.vertical, 9)
        }
        .frame(width: 280)
        .onAppear { searchFocused = true }
        .animation(.easeOut(duration: 0.15), value: query.isEmpty)
    }

    private func set(_ change: @escaping (inout PageFormat) -> Void) {
        withAnimation(.easeOut(duration: 0.2)) { model.store.setPageFormat(page.id, change) }
    }

    private func filtered(_ a: [Action]) -> [Action] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return a }
        return a.filter { $0.title.lowercased().contains(q) }
    }

    private func actions(_ store: WorkspaceStore) -> [Action] {
        var a: [Action] = [
            Action(id: "copy", title: "Copy link", symbol: "link", shortcut: "⌥⌘L") { Clipboard.copy("based://page/" + page.id) },
            Action(id: "dup", title: "Duplicate", symbol: "plus.square.on.square", shortcut: "⌘D") {
                if let id = store.duplicateBlocks([page.id]).first { model.open(id) }
            },
            Action(id: "move", title: "Move to", symbol: "arrow.turn.up.right", shortcut: "⌘⇧P") { editor.picker = .move([page.id]) },
            Action(id: "home", title: model.isHome(page.id) ? "Home page" : "Set as Home page", symbol: "house") { model.setHome(page.id) },
            Action(id: "fav", title: store.isFavorite(page.id) ? "Remove from Favorites" : "Add to Favorites", symbol: "star") { store.toggleFavorite(page.id) },
            Action(id: "undo", title: "Undo", symbol: "arrow.uturn.backward", shortcut: "⌘Z") { model.undo() },
            Action(id: "md", title: "Export as Markdown", symbol: "square.and.arrow.up") { model.exportRequest = AppModel.ExportRequest(pageID: page.id) },
            Action(id: "html", title: "Export as HTML", symbol: "chevron.left.forwardslash.chevron.right") {
                model.exportRequest = AppModel.ExportRequest(pageID: page.id, format: .html)
            },
            Action(id: "tab", title: "Open in new tab", symbol: "plus.rectangle.on.rectangle", shortcut: "⌘↵") { model.openInNewTab(page.id) },
        ]
        if !store.containsProtected(page.id) {
            a.append(Action(id: "del", title: "Move to Trash", symbol: "trash", shortcut: "⌫", destructive: true) { model.trash(page.id) })
        }
        return a
    }

    private var wordCount: Int {
        model.store.descendants(of: page.id, includeRows: false)
            .compactMap { model.store.blocks[$0]?.text.plainText }
            .reduce(0) { $0 + $1.split { $0.isWhitespace || $0.isNewline }.count }
    }
}

/// "Ag" tile for the page font, highlighted when current.
private struct FontTile: View {
    let title: String
    let font: PageFont
    let current: PageFont
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        let selected = font == current
        Button(action: action) {
            VStack(spacing: 2) {
                Text("Ag")
                    .font(sample)
                    .foregroundStyle(selected ? Color.accentColor : Theme.primary)
                Text(title).font(.system(size: 11)).foregroundStyle(Theme.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Theme.hoverFill : .clear))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(selected ? Color.accentColor.opacity(0.6) : .clear, lineWidth: 1.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }

    private var sample: Font {
        switch font {
        case .serif: return .system(size: 22, design: .serif)
        case .mono: return .system(size: 21, design: .monospaced)
        default: return .system(size: 22)
        }
    }
}

/// Menu row with a trailing switch (Notion's "Small text", "Full width" …).
private struct ToggleRow: View {
    let title: String
    let symbol: String
    let on: Bool
    let set: (Bool) -> Void
    @State private var hover = false

    var body: some View {
        Button { set(!on) } label: {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 12)).frame(width: 18).foregroundStyle(Theme.secondary)
                Text(title).font(.system(size: 13.5)).foregroundStyle(Theme.primary)
                Spacer()
                MiniSwitch(on: on)
            }
            .padding(.horizontal, 8).frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 5).fill(hover ? Theme.hoverFill : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Small Notion-like switch with a sliding knob.
struct MiniSwitch: View {
    let on: Bool
    var body: some View {
        Capsule()
            .fill(on ? Color.accentColor : Theme.secondary.opacity(0.3))
            .frame(width: 26, height: 15)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle().fill(.white).frame(width: 11, height: 11).padding(2)
                    .shadow(color: .black.opacity(0.15), radius: 1, y: 0.5)
            }
            .animation(.spring(response: 0.25, dampingFraction: 0.75), value: on)
    }
}

/// Plain action row with icon, title and shortcut hint.
struct PanelActionRow: View {
    let title: String
    let symbol: String
    var shortcut = ""
    var destructive = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 12)).frame(width: 18)
                    .foregroundStyle(destructive && hover ? Color.red : Theme.secondary)
                Text(title).font(.system(size: 13.5)).foregroundStyle(destructive && hover ? Color.red : Theme.primary)
                Spacer()
                if !shortcut.isEmpty { Text(shortcut).font(.system(size: 11.5)).foregroundStyle(Theme.secondary.opacity(0.8)) }
            }
            .padding(.horizontal, 8).frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 5).fill(hover ? (destructive ? Color.red.opacity(0.1) : Theme.hoverFill) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
