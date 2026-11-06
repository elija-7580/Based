import SwiftUI
import UniformTypeIdentifiers
import BasedCore

// MARK: - Icon picker

/// Emoji / icon / upload / link picker for page and callout icons.
struct IconPicker: View {
    let current: PageIcon?
    let onPick: (PageIcon?) -> Void
    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .emoji
    @State private var query = ""
    @State private var link = ""
    @State private var importing = false

    enum Tab: String, CaseIterable { case emoji = "Emoji", icons = "Icons", upload = "Upload", link = "Link" }

    static let symbols = ["doc", "doc.text", "book", "bookmark", "folder", "tray", "archivebox", "calendar", "clock", "alarm",
                          "star", "heart", "flag", "bell", "tag", "pin", "mappin", "house", "building.2", "briefcase",
                          "cart", "creditcard", "chart.bar", "chart.pie", "list.bullet", "checklist", "checkmark.circle",
                          "lightbulb", "bolt", "flame", "leaf", "globe", "airplane", "car", "bicycle", "figure.walk",
                          "person", "person.2", "envelope", "phone", "message", "bubble.left", "camera", "photo", "film",
                          "music.note", "gamecontroller", "paintbrush", "pencil", "scissors", "hammer", "wrench", "gearshape",
                          "cpu", "desktopcomputer", "laptopcomputer", "iphone", "keyboard", "terminal", "link", "lock",
                          "key", "shield", "graduationcap", "books.vertical", "brain", "atom", "function", "sum", "target",
                          "trophy", "gift", "cup.and.saucer", "fork.knife", "cross.case", "pills", "moon", "sun.max", "cloud"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Button("Random") { onPick(.emoji(EmojiCatalog.random())) }
                if current != nil { Button("Remove") { onPick(nil) } }
            }
            switch tab {
            case .emoji:
                TextField("Filter…", text: $query).textFieldStyle(.roundedBorder)
                ScrollView {
                    LazyVGrid(columns: Array(repeating: GridItem(.fixed(32), spacing: 4), count: 10), spacing: 4) {
                        ForEach(EmojiCatalog.search(query, limit: 600), id: \.0) { e in
                            Button { onPick(.emoji(e.0)) } label: {
                                Text(e.0).font(.system(size: 22)).frame(width: 32, height: 32)
                            }
                            .buttonStyle(.plain)
                            .help(e.1)
                        }
                    }
                }
            case .icons:
                TextField("Filter…", text: $query).textFieldStyle(.roundedBorder)
                ScrollView {
                    LazyVGrid(columns: Array(repeating: GridItem(.fixed(32), spacing: 4), count: 10), spacing: 4) {
                        let q = query.lowercased()
                        ForEach(Self.symbols.filter { q.isEmpty || $0.contains(q) }, id: \.self) { s in
                            Button { onPick(.symbol(s)) } label: {
                                Image(systemName: s).font(.system(size: 18)).frame(width: 32, height: 32)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            case .upload:
                Button("Upload file…") { importing = true }
                Text("Recommended size is 280 × 280 pixels").font(.caption).foregroundStyle(Theme.secondary)
                Spacer()
            case .link:
                TextField("Paste link to an image…", text: $link).textFieldStyle(.roundedBorder)
                    .onSubmit { submitLink() }
                Button("Submit") { submitLink() }
                Spacer()
            }
        }
        .padding(10)
        .frame(width: 380, height: 360)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            if case .success(let url) = result, let ref = AssetImport.importFile(url, into: model.assets) { onPick(.asset(ref)) }
        }
    }

    private func submitLink() {
        let l = link.trimmingCharacters(in: .whitespaces)
        guard !l.isEmpty else { return }
        onPick(.url(l))
    }
}

// MARK: - Covers

enum Covers {
    /// Built-in gradient covers (Notion ships a gallery of colours and gradients).
    static let gradients: [[UInt32]] = [
        [0xF6D365, 0xFDA085], [0x84FAB0, 0x8FD3F4], [0xA18CD1, 0xFBC2EB], [0xFBC2EB, 0xA6C1EE],
        [0x667EEA, 0x764BA2], [0x43E97B, 0x38F9D7], [0xFA709A, 0xFEE140], [0x30CFD0, 0x330867],
        [0xFF9A9E, 0xFECFEF], [0x5EE7DF, 0xB490CA], [0x2B5876, 0x4E4376], [0xE0C3FC, 0x8EC5FC],
    ]

    static func color(_ v: UInt32) -> Color {
        let (r, g, b) = Theme.hex(v)
        return Color(red: r, green: g, blue: b)
    }

    static func gradient(_ i: Int) -> LinearGradient {
        let g = gradients[((i % gradients.count) + gradients.count) % gradients.count]
        return LinearGradient(colors: g.map(color), startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

struct CoverView: View {
    let cover: PageCover
    var position: Double = 0.5
    @Environment(AppModel.self) private var model

    var body: some View {
        GeometryReader { geo in
            content
                .frame(width: geo.size.width, height: geo.size.height)
                .clipped()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch cover {
        case .gradient(let i):
            Rectangle().fill(Covers.gradient(i))
        case .color(let c):
            Rectangle().fill(Theme.optionBackground(c.hue))
        case .asset(let a):
            if let url = model.assets.url(for: a), let img = PlatformImage(contentsOfFile: url.path) {
                Image(platformImage: img).resizable().scaledToFill()
            } else {
                Rectangle().fill(Color.gray.opacity(0.2))
            }
        case .url(let u):
            AsyncImage(url: URL(string: u)) { i in i.resizable().scaledToFill() } placeholder: { Color.gray.opacity(0.15) }
        }
    }
}

struct CoverPicker: View {
    let current: PageCover?
    let onPick: (PageCover?) -> Void
    @Environment(AppModel.self) private var model
    @State private var tab = 0
    @State private var link = ""
    @State private var importing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Picker("", selection: $tab) {
                    Text("Gallery").tag(0)
                    Text("Upload").tag(1)
                    Text("Link").tag(2)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if current != nil { Button("Remove") { onPick(nil) } }
            }
            switch tab {
            case 0:
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Color & gradient").font(.caption).foregroundStyle(Theme.secondary)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
                            ForEach(TColor.textColors.filter { $0 != .default }, id: \.self) { c in
                                swatch { Rectangle().fill(Theme.optionBackground(c)) } action: { onPick(.color(c)) }
                            }
                            ForEach(0..<Covers.gradients.count, id: \.self) { i in
                                swatch { Rectangle().fill(Covers.gradient(i)) } action: { onPick(.gradient(i)) }
                            }
                        }
                    }
                }
            case 1:
                Button("Upload file…") { importing = true }
                Text("Images wider than 1500 pixels work best.").font(.caption).foregroundStyle(Theme.secondary)
                Spacer()
            default:
                TextField("Paste an image link…", text: $link).textFieldStyle(.roundedBorder)
                    .onSubmit { if !link.isEmpty { onPick(.url(link)) } }
                Button("Submit") { if !link.isEmpty { onPick(.url(link)) } }
                Spacer()
            }
        }
        .padding(10)
        .frame(width: 420, height: 300)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            if case .success(let url) = result, let ref = AssetImport.importFile(url, into: model.assets) { onPick(.asset(ref)) }
        }
    }

    private func swatch<V: View>(@ViewBuilder _ v: () -> V, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            v().frame(height: 56).clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Page picker (link to page, linked view, move to)

struct PagePicker: View {
    let purpose: PickerPurpose
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var store: WorkspaceStore { model.store }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            TextField(placeholder, text: $query).textFieldStyle(.roundedBorder)
            List {
                if case .move(let ids) = purpose, ids.allSatisfy({ store.blocks[$0]?.type.isPageLike == true }) {
                    Button {
                        model.move(ids, to: .privateTop)
                        done()
                    } label: {
                        Label("Workspace (top level)", systemImage: "square.stack.3d.up")
                    }
                    .buttonStyle(.plain)
                }
                ForEach(candidates, id: \.id) { b in
                    Button { pick(b.id) } label: {
                        HStack {
                            PageIconView(icon: b.props.icon, isDatabase: b.type == .databasePage || b.type == .databaseInline, size: 16)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(store.title(of: b.id)).lineLimit(1)
                                let path = store.ancestors(of: b.id).filter { $0.type.isPageLike }.reversed().map { store.title(of: $0.id) }
                                if !path.isEmpty {
                                    Text(path.joined(separator: " / ")).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
                                }
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(minHeight: 280)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { done() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(14)
        .frame(minWidth: 380, minHeight: 420)
    }

    private var title: String {
        switch purpose {
        case .linkToPage: return "Link to page"
        case .linkedView: return "Create linked view of database"
        case .move: return "Move to"
        }
    }

    private var placeholder: String {
        switch purpose {
        case .linkedView: return "Search databases…"
        default: return "Search pages…"
        }
    }

    private var candidates: [Block] {
        let q = query.trimmingCharacters(in: .whitespaces)
        var list: [Block]
        switch purpose {
        case .linkedView:
            list = store.databases.values.compactMap { db in store.blocks[db.blockID] }
                .filter { !store.isTrashed($0.id) }
        case .linkToPage:
            list = store.allPages()
        case .move(let ids):
            list = store.allPages().filter { p in
                p.type == .page && !ids.contains(p.id) && !ids.contains { store.isDescendant(p.id, of: $0) }
            }
        }
        if !q.isEmpty { list = list.filter { store.title(of: $0.id).localizedCaseInsensitiveContains(q) } }
        list.sort { $0.updatedAt > $1.updatedAt }
        return Array(list.prefix(80))
    }

    private func pick(_ target: RecordID) {
        switch purpose {
        case .linkToPage(let after):
            var p = BlockProps()
            p.linkTarget = target
            if let b = store.blocks[after], b.type == .text, b.text.isEmpty {
                store.updateBlock(after, name: "Link to page") { $0.type = .linkToPage; $0.props = p }
            } else {
                _ = store.insertBlock(.linkToPage, after: after, props: p)
            }
        case .linkedView(let after):
            guard let dbID = store.database(forBlock: target)?.id, let b = store.blocks[after] else { break }
            _ = store.createLinkedView(of: dbID, in: b.parent, at: .after(after))
            if b.type == .text, b.text.isEmpty { store.deleteBlocks([after]) }
        case .move(let ids):
            let pages = ids.filter { store.blocks[$0]?.type.isPageLike == true }
            if pages.count == ids.count {
                model.move(ids, to: .page(target))
            } else {
                store.moveBlocks(ids, to: .block(target), at: .end)
                model.expanded.insert(target)
            }
        }
        done()
    }
}