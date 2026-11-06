import SwiftUI
import BasedCore

/// Browser-style tabs above the content (⌘T new, ⌘W close, ⌃Tab / ⌘1…9 switch, drag to reorder).
struct TabStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let _ = model.registry.workspace.structureRevision   // titles / icons
        HStack(spacing: 0) {
            // Tabs only scroll when they don't fit, so the free title-bar space stays draggable.
            ViewThatFits(in: .horizontal) {
                tabRow
                ScrollView(.horizontal, showsIndicators: false) { tabRow }
            }
            ChromeIconButton(symbol: "plus", size: 13, help: "New tab (⌘T)") { model.newTab() }
                .accessibilityIdentifier("tabs.new")
        }
        .frame(height: 30)
        .accessibilityIdentifier("tabs")
    }

    private var tabRow: some View {
        HStack(spacing: 2) {
            ForEach(model.tabs) { tab in
                TabButton(tab: tab, active: tab.id == model.activeTabID, closable: model.tabs.count > 1)
            }
        }
        .padding(.horizontal, 2)
    }
}

struct TabButton: View {
    let tab: BrowserTab
    let active: Bool
    let closable: Bool
    @Environment(AppModel.self) private var model
    @State private var hover = false
    @State private var dropTarget = false

    var body: some View {
        let info = model.tabInfo(tab)
        HStack(spacing: 6) {
            icon(info.item)
            Text(info.title).lineLimit(1).truncationMode(.tail)
                .font(.system(size: 13, weight: active ? .medium : .regular))
            Spacer(minLength: 0)
            if closable {
                Button { model.closeTab(tab.id) } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                        .frame(width: 16, height: 16).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opacity(hover || active ? 1 : 0)
                .allowsHitTesting(hover || active)
                .help("Close tab (⌘W)")
            }
        }
        .foregroundStyle(active ? Theme.primary : Chrome.sidebarText)
        .padding(.leading, 10).padding(.trailing, 6)
        .frame(minWidth: 90, idealWidth: 180, maxWidth: 220, minHeight: 28, maxHeight: 28)
        .fixedSize(horizontal: true, vertical: false)
        .background {
            // Active tab: white "card" like Notion's desktop tabs; others highlight on hover.
            RoundedRectangle(cornerRadius: 8)
                .fill(active ? Chrome.appBackground : (hover ? Chrome.hover : .clear))
                .shadow(color: .black.opacity(active ? 0.08 : 0), radius: 1.5, y: 0.5)
        }
        .overlay { if active { RoundedRectangle(cornerRadius: 8).stroke(Chrome.border, lineWidth: 0.5) } }
        .overlay(alignment: .leading) { if dropTarget { Rectangle().fill(Color.accentColor).frame(width: 2) } }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { model.selectTab(tab.id) }
        .draggable(tab.id.uuidString)
        .dropDestination(for: String.self) { items, _ in
            guard let s = items.first, let id = UUID(uuidString: s) else { return false }
            model.moveTab(id, before: tab.id)
            return true
        } isTargeted: { dropTarget = $0 }
        .contextMenu {
            Button("New tab", systemImage: "plus") { model.newTab() }
            Button("Duplicate tab", systemImage: "plus.square.on.square") { model.newTab(info.item, path: tab.id == model.activeTabID ? [] : tab.path) }
            if closable {
                Divider()
                Button("Close tab", systemImage: "xmark") { model.closeTab(tab.id) }
                Button("Close other tabs") { for t in model.tabs where t.id != tab.id { model.closeTab(t.id) } }
            }
        }
        .help(info.title)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tab")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    @ViewBuilder
    private func icon(_ item: SidebarItem?) -> some View {
        if case .page(let id)? = item {
            PageIconView(icon: model.store.icon(of: id), isDatabase: model.store.blocks[id]?.type == .databasePage, size: 14)
                .frame(width: 16, height: 16)
        } else {
            Image(systemName: item?.symbol ?? "house").font(.system(size: 11)).frame(width: 16, height: 16)
        }
    }
}
