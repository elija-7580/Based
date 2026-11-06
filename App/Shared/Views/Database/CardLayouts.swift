import SwiftUI
import BasedCore

/// Card used by board and gallery layouts.
struct RowCard: View {
    let ctx: DBContext
    let row: Block
    var showCover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if showCover { cover.frame(height: coverHeight).clipped() }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if ctx.view.showIcons != false, let icon = row.props.icon { icon.view(size: 16, assets: ctx.model.assets).frame(width: 18, height: 18) }
                    Text(row.title.isEmpty ? "Untitled" : row.title).font(.system(size: 14, weight: .medium)).lineLimit(ctx.view.wrapCells == true ? nil : 2)
                }
                ForEach(ctx.cardProperties) { p in
                    let v = ctx.value(row, p)
                    if !v.isEmpty {
                        PropertyValueView(property: p, value: v, row: row, wrap: ctx.view.wrapCells == true)
                            .font(.system(size: 12))
                    }
                }
            }
            .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(.background).shadow(color: .black.opacity(0.12), radius: 1.5, y: 1))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(Theme.divider)))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { ctx.open(row.id) }
        .contextMenu { RowMenuItems(ctx: ctx, row: row) }
        .onDrag {
            ctx.model.draggedBlocks = [row.id]
            return NSItemProvider(object: row.id as NSString)
        }
    }

    private var coverHeight: CGFloat {
        switch ctx.view.cardSize ?? .medium {
        case .small: return 100
        case .medium: return 140
        case .large: return 200
        }
    }

    @ViewBuilder
    private var cover: some View {
        switch ctx.view.cardCover ?? .pageContent {
        case .none:
            EmptyView()
        case .pageCover:
            if let c = row.props.cover { CoverView(cover: c, position: row.props.format?.coverPosition ?? 0.5) } else { Color.primary.opacity(0.03) }
        case .property(let pid):
            if case .files(let files)? = row.values[pid], let f = files.first {
                if let a = f.asset, let url = ctx.model.assets.url(for: a), let img = PlatformImage(contentsOfFile: url.path) {
                    Image(platformImage: img).resizable().scaledToFill()
                } else if let u = f.url {
                    AsyncImage(url: URL(string: u)) { i in i.resizable().scaledToFill() } placeholder: { Color.primary.opacity(0.03) }
                }
            } else {
                Color.primary.opacity(0.03)
            }
        case .pageContent:
            contentPreview
        }
    }

    @ViewBuilder
    private var contentPreview: some View {
        let blocks = ctx.store.contentBlocks(of: row.id)
        if let img = blocks.first(where: { $0.type == .image }), let a = img.props.asset,
           let url = ctx.model.assets.url(for: a), let p = PlatformImage(contentsOfFile: url.path) {
            Image(platformImage: p).resizable().scaledToFill()
        } else if let img = blocks.first(where: { $0.type == .image }), let u = img.props.url {
            AsyncImage(url: URL(string: u)) { i in i.resizable().scaledToFill() } placeholder: { Color.primary.opacity(0.03) }
        } else {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(blocks.prefix(6), id: \.id) { b in
                    Text(b.text.plainText).font(.system(size: b.type.isHeading ? 9 : 7, weight: b.type.isHeading ? .semibold : .regular))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.primary.opacity(0.03))
        }
    }
}

// MARK: - Board

struct BoardLayout: View {
    let ctx: DBContext

    var body: some View {
        if let groups = ctx.visibleGroups {
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(groups) { g in BoardColumn(ctx: ctx, group: g, allGroups: ctx.result.groups ?? []) }
                    if !ctx.hiddenGroups.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Hidden groups").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondary)
                            ForEach(ctx.hiddenGroups) { g in
                                Button { ctx.setGroupHidden(g.id, false) } label: {
                                    HStack { GroupTitle(group: g, property: ctx.groupProperty); Text("\(g.rows.count)").foregroundStyle(Theme.secondary) }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .frame(width: 200, alignment: .leading)
                    }
                    if !ctx.locked, let p = ctx.groupProperty, [.select, .multiSelect, .status].contains(p.type) {
                        NewGroupButton(ctx: ctx, property: p)
                    }
                }
                .padding(.vertical, 4)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Group the board by a select, status, person or checkbox property in view settings.")
                    .foregroundStyle(Theme.secondary)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 10)], spacing: 10) {
                    ForEach(ctx.result.rows, id: \.id) { r in RowCard(ctx: ctx, row: r) }
                }
            }
        }
    }
}

struct BoardColumn: View {
    let ctx: DBContext
    let group: RowGroup
    let allGroups: [RowGroup]
    @State private var targeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                GroupTitle(group: group, property: ctx.groupProperty)
                Text("\(group.rows.count)").foregroundStyle(Theme.secondary)
                Spacer()
                Menu {
                    Button("Hide group") { ctx.setGroupHidden(group.id, true) }
                    if let p = ctx.groupProperty, !group.isEmptyGroup, [.select, .multiSelect, .status].contains(p.type) {
                        Menu("Color") {
                            ForEach(TColor.textColors, id: \.self) { c in
                                Button(c.displayName) { ctx.store.updateOption(ctx.db.id, p.id, group.id) { $0.color = c } }
                            }
                        }
                        Button("Delete group", role: .destructive) { ctx.store.deleteOption(ctx.db.id, p.id, group.id) }
                    }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                if !ctx.locked {
                    Button { ctx.open(ctx.addRow(values: ctx.groupValues(group.id))) } label: { Image(systemName: "plus") }
                        .buttonStyle(.plain)
                }
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Theme.secondary)
            ForEach(group.rows, id: \.id) { r in RowCard(ctx: ctx, row: r) }
            if !ctx.locked {
                Button { ctx.open(ctx.addRow(values: ctx.groupValues(group.id))) } label: {
                    Label("New page", systemImage: "plus").foregroundStyle(Theme.secondary).frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 4)
            }
        }
        .padding(8)
        .frame(width: 260, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 8).fill(group.color.map { Theme.optionBackground($0).opacity(0.35) } ?? Color.primary.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor, lineWidth: targeted ? 2 : 0))
        .onDrop(of: [.text], isTargeted: $targeted) { _ in
            guard !ctx.locked else { return false }
            let ids = ctx.model.draggedBlocks
            ctx.model.draggedBlocks = []
            for id in ids {
                let old = allGroups.first { g in g.rows.contains { $0.id == id } }?.id
                if old != group.id { ctx.move(id, toGroup: group.id, from: old) }
            }
            return !ids.isEmpty
        }
    }
}

struct NewGroupButton: View {
    let ctx: DBContext
    let property: PropertySchema
    @State private var adding = false
    @State private var name = ""

    var body: some View {
        if adding {
            TextField("Group name", text: $name)
                .textFieldStyle(.roundedBorder)
                .frame(width: 200)
                .onSubmit {
                    let n = name.trimmingCharacters(in: .whitespaces)
                    if !n.isEmpty { _ = ctx.store.addOption(ctx.db.id, property.id, name: n) }
                    name = ""; adding = false
                }
        } else {
            Button { adding = true } label: { Label("New group", systemImage: "plus").foregroundStyle(Theme.secondary) }
                .buttonStyle(.plain)
                .frame(width: 200, alignment: .leading)
                .padding(.top, 8)
        }
    }
}

// MARK: - Gallery

struct GalleryLayout: View {
    let ctx: DBContext

    var body: some View {
        let min: CGFloat = {
            switch ctx.view.cardSize ?? .medium { case .small: return 180; case .medium: return 240; case .large: return 320 }
        }()
        VStack(alignment: .leading, spacing: 10) {
            if let groups = ctx.visibleGroups {
                ForEach(groups) { g in
                    GroupHeader(ctx: ctx, group: g) {}
                    grid(g.rows, min: min, values: ctx.groupValues(g.id))
                }
            } else {
                grid(ctx.result.rows, min: min, values: [:])
            }
        }
    }

    private func grid(_ rows: [Block], min: CGFloat, values: [String: PropertyValue]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: min), spacing: 12)], alignment: .leading, spacing: 12) {
            ForEach(rows, id: \.id) { r in RowCard(ctx: ctx, row: r, showCover: ctx.view.cardCover != CardCover.none) }
            if !ctx.locked {
                Button { ctx.open(ctx.addRow(values: values)) } label: {
                    Label("New page", systemImage: "plus").foregroundStyle(Theme.secondary)
                        .frame(maxWidth: .infinity, minHeight: 80)
                        .background(RoundedRectangle(cornerRadius: 6).stroke(Color(Theme.divider), style: StrokeStyle(lineWidth: 1, dash: [4])))
                }
                .buttonStyle(.plain)
            }
        }
    }
}