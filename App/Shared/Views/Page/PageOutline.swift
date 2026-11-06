import SwiftUI
import BasedCore

/// Floating outline on the right edge of a page (like Notion's table of contents rail):
/// collapsed to small bars, expands on hover/tap to show headings, click scrolls to the heading.
struct PageOutline: View {
    let pageID: RecordID
    let scroll: ScrollViewProxy
    @Environment(AppModel.self) private var model
    @State private var expanded = false

    struct Entry: Identifiable { let id: RecordID; let title: String; let level: Int }

    private var entries: [Entry] {
        let store = model.store
        return store.visibleOrder(in: pageID).compactMap { id in
            guard let b = store.blocks[id], b.type.isHeading, b.trashedAt == nil else { return nil }
            let level = b.type == .heading1 ? 1 : b.type == .heading2 ? 2 : 3
            return Entry(id: id, title: b.title.isEmpty ? "Untitled heading" : b.title, level: level)
        }
    }

    var body: some View {
        // Observe edits: the rail appears as soon as the page has headings (before, it was computed once).
        let _ = model.registry.workspace.revision
        let items = entries
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: expanded ? 2 : 6) {
                ForEach(items) { e in
                    if expanded {
                        Button {
                            withAnimation(.easeInOut(duration: 0.25)) { scroll.scrollTo(e.id, anchor: .top) }
                        } label: {
                            Text(e.title).font(.system(size: 13)).lineLimit(1)
                                .foregroundStyle(e.level == 1 ? Theme.primary : Theme.secondary)
                                .padding(.vertical, 4).padding(.horizontal, 8)
                                .padding(.leading, CGFloat(e.level - 1) * 12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.clear))
                    } else {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(Color(Theme.textSecondary).opacity(e.level == 1 ? 0.8 : 0.55))
                            .frame(width: e.level == 1 ? 20 : e.level == 2 ? 14 : 9, height: 3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(expanded ? 8 : 10)
            .frame(width: expanded ? 240 : 38, alignment: .leading)
            .background {
                if expanded {
                    RoundedRectangle(cornerRadius: 10).fill(.regularMaterial)
                        .shadow(color: .black.opacity(0.12), radius: 14, y: 4)
                }
            }
            .contentShape(Rectangle())
            .onHover { h in withAnimation(.spring(duration: 0.28)) { expanded = h } }
            .onTapGesture { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } }
            .padding(.trailing, 8)
            .padding(.top, 72)
            .animation(.spring(duration: 0.28), value: expanded)
            .accessibilityLabel("Page outline")
        }
    }
}
