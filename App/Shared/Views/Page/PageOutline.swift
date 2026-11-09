import SwiftUI
import BasedCore

/// Floating outline on the right edge of a page (ChatGPT / Notion style): a column of thin, soft, rounded
/// lines — one per heading — that brighten under the pointer and, after a short hover, morph into a panel
/// with the headings. Click a line or a heading to scroll there.
struct PageOutline: View {
    let pageID: RecordID
    let scroll: ScrollViewProxy
    /// Distance from the top: below the cover when the page has one (the rail used to sit on the cover).
    var topInset: CGFloat = 72
    @Environment(AppModel.self) private var model
    @State private var expanded = false
    @State private var hoverRail = false
    @State private var hoverTask: Task<Void, Never>?

    struct Entry: Identifiable, Equatable { let id: RecordID; let level: Int }

    private var entries: [Entry] {
        let store = model.store
        return store.visibleOrder(in: pageID).compactMap { id in
            guard let b = store.blocks[id], b.type.isHeading, b.trashedAt == nil else { return nil }
            let level = b.type == .heading1 ? 1 : b.type == .heading2 ? 2 : 3
            return Entry(id: id, level: level)
        }
    }

    var body: some View {
        // Headings come and go with structural changes (new block, type change); their titles are observed per
        // heading below, so typing elsewhere on the page doesn't rebuild the outline.
        let _ = model.registry.workspace.structureRevision
        let items = entries
        if !items.isEmpty {
            ZStack(alignment: .topTrailing) {
                rail(items)
                    .opacity(expanded ? 0 : 1)
                    .scaleEffect(x: expanded ? 0.6 : 1, y: 1, anchor: .trailing)
                if expanded {
                    panel(items)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .scale(scale: 0.96, anchor: .topTrailing)).combined(with: .offset(x: 6)),
                            removal: .opacity.combined(with: .scale(scale: 0.98, anchor: .topTrailing))))
                }
            }
            .contentShape(Rectangle())
            .onHover(perform: hover)
            .padding(.trailing, 10)
            .padding(.top, topInset)
            .animation(.spring(response: 0.3, dampingFraction: 0.86), value: expanded)
            .animation(.easeOut(duration: 0.15), value: hoverRail)
            .accessibilityLabel("Page outline")
            .onDisappear { hoverTask?.cancel() }
        }
    }

    /// Short delay before the panel opens, so passing over the rail with the pointer doesn't flash it.
    private func hover(_ inside: Bool) {
        hoverTask?.cancel()
        hoverRail = inside
        if inside {
            hoverTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(140))
                if !Task.isCancelled { expanded = true }
            }
        } else {
            hoverTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(120))
                if !Task.isCancelled { expanded = false }
            }
        }
    }

    private func jump(_ id: RecordID) {
        // Headings further down may not be built yet (progressive page build): build them, then scroll.
        if let ed = model.activeEditor, ed.pageID == pageID, ed.revealLimit != .max {
            ed.revealAll()
            DispatchQueue.main.async { withAnimation(.smooth(duration: 0.35)) { scroll.scrollTo(id, anchor: .top) } }
        } else {
            withAnimation(.smooth(duration: 0.35)) { scroll.scrollTo(id, anchor: .top) }
        }
    }

    private func rail(_ items: [Entry]) -> some View {
        VStack(alignment: .trailing, spacing: 9) {
            ForEach(items) { e in
                Capsule(style: .continuous)
                    .fill(Theme.primary.opacity(hoverRail ? (e.level == 1 ? 0.55 : 0.4) : (e.level == 1 ? 0.28 : 0.18)))
                    .frame(width: e.level == 1 ? 16 : e.level == 2 ? 11 : 7, height: 2)
                    .frame(width: 24, alignment: .trailing)
                    .contentShape(Rectangle().inset(by: -4))
                    .onTapGesture { jump(e.id) }
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, DS.Space.sm)
    }

    private func panel(_ items: [Entry]) -> some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(items) { e in
                    OutlineRow(id: e.id, level: e.level) { jump(e.id) }
                }
            }
            .padding(DS.Space.sm)
        }
        .frame(width: 248)
        .frame(maxHeight: 460)
        .fixedSize(horizontal: false, vertical: true)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous)
                .fill(.regularMaterial)
                .shadow(color: .black.opacity(0.14), radius: 18, y: 6)
        )
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.panel, style: .continuous).strokeBorder(Theme.primary.opacity(0.07)))
    }
}

/// One heading in the expanded outline; observes only its own block, so it follows renames.
private struct OutlineRow: View {
    let id: RecordID
    let level: Int
    let action: () -> Void
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        let title = model.registry.block(id).block?.title ?? ""
        Button(action: action) {
            Text(title.isEmpty ? "Untitled heading" : title)
                .font(.system(size: 13, weight: level == 1 ? .medium : .regular))
                .lineLimit(1)
                .foregroundStyle(level == 1 ? Theme.primary : Theme.secondary)
                .padding(.vertical, 5).padding(.horizontal, DS.Space.md)
                .padding(.leading, CGFloat(level - 1) * 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous).fill(Theme.primary.opacity(hover ? 0.07 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.08)) { hover = h } }
    }
}
