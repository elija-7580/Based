import SwiftUI
import BasedCore

/// ⌘F — find in the current page. Matches are blocks whose plain text contains the query; Enter / ⌘G jump to
/// the next match (⇧ for previous), the page scrolls to it and marks the block.
struct FindBar: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    @State private var matches: [RecordID] = []

    var body: some View {
        @Bindable var model = model
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.secondary)
            TextField("Find in page", text: $model.findQuery)
                .textFieldStyle(.plain)
                .frame(width: 200)
                .focused($focused)
                .onSubmit { step(+1) }
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.shift) else { return .ignored }
                    step(-1)
                    return .handled
                }
                .onKeyPress(.escape) { close(); return .handled }
                .accessibilityIdentifier("find.field")
            Text(status)
                .font(.caption.monospacedDigit())
                .foregroundStyle(matches.isEmpty && !model.findQuery.isEmpty ? Color.red.opacity(0.8) : Theme.secondary)
                .frame(minWidth: 54, alignment: .trailing)
                .accessibilityIdentifier("find.count")
            Divider().frame(height: 14)
            Button { step(-1) } label: { Image(systemName: "chevron.up") }
                .disabled(matches.isEmpty)
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .help("Previous match (⇧⌘G)")
            Button { step(+1) } label: { Image(systemName: "chevron.down") }
                .disabled(matches.isEmpty)
                .keyboardShortcut("g", modifiers: .command)
                .help("Next match (⌘G)")
            Button { close() } label: { Image(systemName: "xmark") }
                .help("Close (Esc)")
                .accessibilityIdentifier("find.close")
        }
        .buttonStyle(.hoverFill)
        .foregroundStyle(Theme.secondary)
        .font(.system(size: 13))
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(.regularMaterial).shadow(color: .black.opacity(0.15), radius: 8, y: 3))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color(Theme.divider)))
        .accessibilityIdentifier("find.bar")
        .onAppear { focused = true; recompute(); jump() }
        .onChange(of: model.findQuery) { _, _ in model.findIndex = 0; recompute(); jump() }
        .onChange(of: model.currentPageID) { _, _ in model.findIndex = 0; recompute() }
        .onChange(of: model.findFocusRequest) { _, _ in focused = true }
    }

    private var status: String {
        if model.findQuery.isEmpty { return "" }
        if matches.isEmpty { return "No results" }
        return "\(min(model.findIndex, matches.count - 1) + 1) of \(matches.count)"
    }

    /// Blocks of the page (document order, no database rows) whose text contains the query.
    private func recompute() {
        let q = model.findQuery.trimmingCharacters(in: .whitespaces)
        guard let page = model.currentPageID, !q.isEmpty else { matches = []; return }
        let store = model.store
        matches = Log.measure("find", category: "ui", warnAfter: 0.05) {
            store.descendants(of: page, includeRows: false).filter { id in
                guard let b = store.blocks[id], b.trashedAt == nil, store.containingPage(of: id) == page else { return false }
                return b.text.plainText.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }

    private func step(_ delta: Int) {
        guard !matches.isEmpty else { return }
        model.findIndex = (model.findIndex + delta + matches.count) % matches.count
        jump()
    }

    private func jump() {
        guard !matches.isEmpty else { model.findTarget = nil; return }
        let target = matches[min(model.findIndex, matches.count - 1)]
        // Re-assign even if unchanged so the page scrolls back to it.
        if model.findTarget == target { model.findTarget = nil }
        model.findTarget = target
    }

    private func close() {
        model.showFind = false
        model.findTarget = nil
        matches = []
    }
}
