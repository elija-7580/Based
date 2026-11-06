import SwiftUI
import BasedCore

/// Browser-style tabs above the content (⌘T new, ⌘W close, ⌃Tab / ⌘1…9 switch, drag to reorder).
struct TabStrip: View {
    @Environment(AppModel.self) private var model
    /// Tab frames in the strip's coordinate space (for live reordering while dragging).
    @State private var frames: [UUID: CGRect] = [:]
    @State private var drag: TabDrag?

    struct TabDrag: Equatable { var id: UUID; var grabOffset: CGFloat; var pointerX: CGFloat }

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
                let dragged = drag?.id == tab.id
                TabButton(tab: tab, active: tab.id == model.activeTabID, closable: model.tabs.count > 1)
                    .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named("tabs")) }) { frames[tab.id] = $0 }
                    // The dragged tab follows the pointer; the others slide into place as it passes them.
                    .offset(x: dragged ? dragOffset(tab.id) : 0)
                    .zIndex(dragged ? 1 : 0)
                    .shadow(color: .black.opacity(dragged ? 0.18 : 0), radius: 6, y: 2)
                    .gesture(reorderGesture(tab.id))
            }
        }
        .padding(.horizontal, 2)
        .coordinateSpace(.named("tabs"))
        .animation(.spring(duration: 0.22), value: model.tabs.map(\.id))
    }

    private func dragOffset(_ id: UUID) -> CGFloat {
        guard let d = drag, let f = frames[id] else { return 0 }
        return d.pointerX - d.grabOffset - f.minX
    }

    /// Own drag instead of system drag & drop: the title bar's window-drag area and the system drag session
    /// fought over the gesture, drops only worked "before" a tab, and nothing moved until the drop.
    private func reorderGesture(_ id: UUID) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .named("tabs"))
            .onChanged { v in
                if drag?.id != id {
                    let f = frames[id] ?? .zero
                    drag = TabDrag(id: id, grabOffset: v.startLocation.x - f.minX, pointerX: v.location.x)
                    if id != model.activeTabID { model.selectTab(id) }
                }
                drag?.pointerX = v.location.x
                // Move past a neighbour once the pointer crosses its middle.
                guard let from = model.tabs.firstIndex(where: { $0.id == id }) else { return }
                let x = v.location.x
                if from + 1 < model.tabs.count, let next = frames[model.tabs[from + 1].id], x > next.midX {
                    model.moveTab(id, toIndex: from + 1)
                } else if from > 0, let prev = frames[model.tabs[from - 1].id], x < prev.midX {
                    model.moveTab(id, toIndex: from - 1)
                }
            }
            .onEnded { _ in withAnimation(.spring(duration: 0.22)) { drag = nil } }
    }
}

struct TabButton: View {
    let tab: BrowserTab
    let active: Bool
    let closable: Bool
    @Environment(AppModel.self) private var model
    @State private var hover = false

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
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { model.selectTab(tab.id) }
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
            SymbolImage(name: item.map { $0.mode == .ai && $0 == .chat(nil) ? SymbolImage.ai : $0.symbol } ?? "house", size: 11).frame(width: 16, height: 16)
        }
    }
}
