import SwiftUI
import BasedCore

/// Trash (sidebar footer → Trash, or as a sheet): every trashed page / database / row with its
/// location, when it was deleted and how many sub-pages went with it. Restore brings the item and its
/// sub-pages back; "Delete permanently" asks first and cannot be undone.
struct TrashView: View {
    var sheet = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var confirmDelete: [RecordID]?
    @State private var confirmEmpty = false

    var body: some View {
        let _ = model.registry.workspace.structureRevision
        let store = model.store
        let all = store.trashedPages()
        let items = all.filter { query.isEmpty || store.title(of: $0.id).localizedCaseInsensitiveContains(query) }
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Trash").font(.system(size: 22, weight: .bold))
                Spacer()
                if !all.isEmpty {
                    Button("Empty Trash", role: .destructive) { confirmEmpty = true }
                        .accessibilityIdentifier("trash.empty")
                }
                if sheet { Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) }
            }
            TextField("Search pages in Trash…", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("trash.search")
            if items.isEmpty {
                ContentUnavailableView(all.isEmpty ? "Trash is empty" : "No matches", systemImage: "trash",
                                       description: Text("Pages in Trash are deleted permanently after 30 days."))
            } else {
                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(items, id: \.id) { b in
                            TrashRow(block: b, onOpen: {
                                if sheet { dismiss() }
                                model.open(b.id)
                            }, onRestore: { model.restore([b.id]) }, onDelete: { confirmDelete = [b.id] })
                        }
                    }
                }
                Text("\(all.count) item\(all.count == 1 ? "" : "s") in Trash · deleted permanently after 30 days")
                    .font(.system(size: 12)).foregroundStyle(Chrome.sectionText)
            }
        }
        .padding(sheet ? 16 : 28)
        .frame(minWidth: 460, minHeight: 420)
        .frame(maxWidth: sheet ? nil : 900, maxHeight: .infinity, alignment: .top)
        .confirmationDialog("Delete permanently?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("Delete permanently", role: .destructive) {
                if let ids = confirmDelete { model.deleteForever(ids) }
                confirmDelete = nil
            }
        } message: {
            Text(deleteMessage(confirmDelete ?? []))
        }
        .confirmationDialog("Permanently delete everything in Trash?", isPresented: $confirmEmpty) {
            Button("Delete \(all.count) item\(all.count == 1 ? "" : "s") permanently", role: .destructive) {
                model.deleteForever(all.map(\.id))
            }
        } message: { Text("This cannot be undone.") }
        .accessibilityIdentifier("trash")
    }

    private func deleteMessage(_ ids: [RecordID]) -> String {
        let store = model.store
        guard let id = ids.first else { return "" }
        let inside = store.trashedDescendantPages(of: id).count
        let title = store.title(of: id).nonEmptyOr("Untitled")
        return "“\(title)”" + (inside > 0 ? " and \(inside) page\(inside == 1 ? "" : "s") inside it" : "") + " will be deleted. This cannot be undone."
    }
}

struct TrashRow: View {
    let block: Block
    let onOpen: () -> Void
    let onRestore: () -> Void
    let onDelete: () -> Void
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        let store = model.store
        let isDB = block.type == .databasePage || block.type == .databaseInline
        let inside = store.trashedDescendantPages(of: block.id).count
        HStack(spacing: 10) {
            PageIconView(icon: block.props.icon, isDatabase: isDB, size: 18).frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(store.title(of: block.id).nonEmptyOr("Untitled"))
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.primary).lineLimit(1)
                Text(subtitle(inside: inside)).font(.system(size: 12)).foregroundStyle(Chrome.sectionText).lineLimit(1)
            }
            Spacer(minLength: 8)
            Button(action: onRestore) {
                Label("Restore", systemImage: "arrow.uturn.backward").font(.system(size: 13))
            }
            .buttonStyle(.borderless)
            .help("Restore (with \(inside) page\(inside == 1 ? "" : "s") inside)")
            .accessibilityIdentifier("trash.restore")
            Button(role: .destructive, action: onDelete) {
                Label("Delete permanently", systemImage: "trash").font(.system(size: 13))
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("trash.deleteForever")
        }
        .padding(.horizontal, 10)
        .frame(height: 44)
        .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Chrome.hover : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(count: 2, perform: onOpen)
        .contextMenu {
            Button("Restore", systemImage: "arrow.uturn.backward", action: onRestore)
            Button("Open", systemImage: "arrow.up.right.square", action: onOpen)
            Divider()
            Button("Delete permanently", systemImage: "trash", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trash.row")
    }

    private func subtitle(inside: Int) -> String {
        let store = model.store
        var parts: [String] = []
        switch block.parent {
        case .workspace:
            parts.append(block.props.teamspace.flatMap { store.teamspace($0)?.name } ?? "Private")
        case .block(let p): parts.append("in " + store.title(of: p).nonEmptyOr("Untitled"))
        case .database(let d):
            if let owner = store.databases[d]?.blockID { parts.append("in " + store.title(of: owner).nonEmptyOr("Untitled")) }
        }
        if let t = block.trashedAt { parts.append("deleted " + t.formatted(.relative(presentation: .named))) }
        if inside > 0 { parts.append("\(inside) page\(inside == 1 ? "" : "s") inside") }
        return parts.joined(separator: " · ")
    }
}

/// Bottom toast ("“Page” moved to Trash · Undo"), like Notion's snackbar.
struct ToastHost: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            if let t = model.toast {
                HStack(spacing: 12) {
                    Text(t.message).font(.system(size: 13, weight: .medium)).foregroundStyle(.white).lineLimit(1)
                        .accessibilityIdentifier("toast.message")
                    if let action = t.actionTitle {
                        Button(action) { model.performToastAction() }
                            .buttonStyle(.plain)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color(Theme.dynamic(light: 0x9ECBFF, dark: 0x9ECBFF)))
                            .keyboardShortcut("z", modifiers: .command)
                            .accessibilityIdentifier("toast.action")
                    }
                    Button { model.toast = nil } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
                        .buttonStyle(.quiet)
                        .foregroundStyle(.white.opacity(0.7))
                        .help("Dismiss")
                }
                .padding(.horizontal, 14)
                .frame(height: 36)
                .background(Capsule().fill(Color(Theme.dynamic(light: 0x2F2F2F, dark: 0x3A3A3A))))
                .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("toast")
            }
        }
        .animation(.easeOut(duration: 0.18), value: model.toast)
    }
}

/// "Move to…" parent picker: Private, each teamspace, or any page (search by title / path). Excludes the
/// moved pages and everything inside them.
struct MovePicker: View {
    let ids: [RecordID]
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""

    var body: some View {
        let store = model.store
        let q = query.trimmingCharacters(in: .whitespaces)
        let targets = candidates(q)
        VStack(alignment: .leading, spacing: 8) {
            Text(ids.count == 1 ? "Move “\(store.title(of: ids[0]).nonEmptyOr("Untitled"))” to" : "Move \(ids.count) pages to")
                .font(.headline).lineLimit(1)
            TextField("Search for a page, teamspace or Private…", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("move.search")
            List {
                if q.isEmpty || "private".localizedCaseInsensitiveContains(q) {
                    destination("Private", subtitle: "Top level", symbol: "lock") { model.move(ids, to: .privateTop) }
                }
                ForEach(store.teamspaces.filter { q.isEmpty || $0.name.localizedCaseInsensitiveContains(q) }, id: \.id) { t in
                    destination(t.name, subtitle: "Teamspace", symbol: "person.2") { model.move(ids, to: .teamspace(t.id)) }
                }
                ForEach(targets, id: \.id) { b in
                    Button {
                        model.move(ids, to: .page(b.id))
                        done()
                    } label: {
                        HStack(spacing: 8) {
                            PageIconView(icon: b.props.icon, isDatabase: false, size: 16)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(store.title(of: b.id).nonEmptyOr("Untitled")).lineLimit(1)
                                Text(path(b)).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("move.target")
                }
            }
            .frame(minHeight: 300)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { done() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(14)
        .frame(minWidth: 420, minHeight: 460)
        .accessibilityIdentifier("move.picker")
    }

    private func destination(_ title: String, subtitle: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button { action(); done() } label: {
            HStack(spacing: 8) {
                Image(systemName: symbol).frame(width: 16)
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(Theme.secondary)
                }
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("move.destination")
    }

    private func path(_ b: Block) -> String {
        let store = model.store
        let chain = store.ancestors(of: b.id).filter { $0.type.isPageLike }.reversed()
        let top = chain.first ?? b
        let section = top.props.teamspace.flatMap { store.teamspace($0)?.name } ?? "Private"
        return ([section] + chain.map { store.title(of: $0.id).nonEmptyOr("Untitled") }).joined(separator: " / ")
    }

    private func candidates(_ q: String) -> [Block] {
        let store = model.store
        var list = store.allPages().filter { p in
            p.type == .page && !ids.contains(p.id) && !ids.contains { store.isDescendant(p.id, of: $0) }
        }
        if !q.isEmpty { list = list.filter { store.title(of: $0.id).localizedCaseInsensitiveContains(q) } }
        list.sort { $0.updatedAt > $1.updatedAt }
        return Array(list.prefix(100))
    }
}
